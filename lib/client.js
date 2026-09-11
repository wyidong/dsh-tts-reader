/**
 * dsh-tts-reader — 浏览器侧（browser half）。
 *
 * 在每条已定稿的助手消息的 action 条带上贡献一个「🔊 播放 / ⏹ 停止」按钮，
 * 用浏览器原生 speechSynthesis 朗读消息正文。
 *
 * - slot：conversation.chat.assistant-actions（order 15，位于反馈按钮之后）
 * - 文本来源（主）：从会话投影按 messageId 取最终助手消息的 blocks 正文，
 *   精确对应"这条消息"本身，不含工具过程与叙述。
 * - 文本来源（兜底）：DOM 分段提取（extractMessageText）。
 * - 精华模式：只念叙述性正文 —— 跳过代码块、列表、表格与工具卡片；
 *   朗读前清洗：剥掉表情/Markdown 标记，保留句子标点做停顿。
 * - 语音：9 个预设 —— 8 项普通话「性别 × 风格」（女声 4 + 男声 4）+ 四川话 1 项（REQ-010），
 *   可微调语速/音高。四川话仅男声（Web Speech API 无四川话女声；女声需云 TTS，与零依赖定位冲突，
 *   列为待评估未实现），依赖宿主提供 zh-CN-Sichuan 语音（Edge 在线语音），
 *   宿主没有时优雅回退到普通话语音——照常能读、不报错。
 * - 设置页：settings.plugins.tab 上的「朗读」Tab；设置经 localStorage 持久化
 *   （第三方插件位置无法 import 宿主 settings 依赖，故用浏览器本地存储），
 *   支持自动播放（新回复自动开读，sessionStorage 去重）。
 * - 过程播报（REQ-009）：可选开关（默认关，且**依赖自动播放**：autoPlay 关时不可开、
 *   已开的也会被读时钳成关）。开启后监控当前会话里 status==='running'
 *   的助手 step，把它流式增长的 text 块按「句尾 / 满 90 字 / 流停 1.2s」切块实时朗读，
 *   让用户在 Agent 干活（调工具、写回复）期间就能听到它在做什么。
 *   BUG-025（含「宁可慢但顺」精修轮）后的播报语义：**引擎彻底空闲才开口** ——
 *   过程段之间串行，绝不在词中间掐断正在播的段；换 step / 新回复时等旧段自然念完
 *   再平滑切到当前内容（切换仍会发生，只是晚几秒）；新节点的**第一句成句才念**
 *   （不念"明白，"这类碎片，避免开口即卡顿）；用户手动 🔊 期间完全让路。
 *   BUG-026 追加的**跨会话**语义：**切走即停、旧会话弃用** —— 用户切到别的会话，
 *   等于宣告「不想再听老会话没播完的内容」：立刻 stopSpeaking()、丢弃旧会话的未念尾巴，
 *   并把它当时那一轮记进 `abandonedTurns` 弃用表；之后哪怕 current 回落到旧会话
 *   （子会话结束等），只要它还在**同一轮**就一律静默，直到它开出**新的一轮**才恢复播报。
 *   注意这条只管**跨会话**：同一会话内换 step 仍走 BUG-025 的「冲刷尾巴再平滑接力」。
 * - 全局单例：同一时刻只有一个按钮在朗读，再点自己＝停止。
 */
window.__ModuleLoader__.load({
	id: "dsh-tts-reader",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		/** 本插件需要的客户端服务。 */
		const inject = ["slots", "sessions"];

		/** 全局朗读状态：同一时刻只有一个按钮在播。 */
		const state = { speaking: false, button: null, setter: null };

		/** 客户端根上下文（apply 时绑定，供投影读取）。 */
		let ttsCtx = null;

		/** 已自动朗读过的 messageId（sessionStorage 持久化，避免重复念、刷新后再念）。 */
		const SPOKEN_KEY = "dsh-tts-reader.spoken";
		/** 只保留最近 N 条已朗读记录，防止 sessionStorage 无限膨胀（BUG-016）。 */
		const SPOKEN_MAX = 200;
		const spokenIds = new Set();
		function loadSpokenIds() {
			try {
				const raw = sessionStorage.getItem(SPOKEN_KEY);
				if (raw) for (const id of JSON.parse(raw)) spokenIds.add(id);
			} catch (e) { /* 忽略 */ }
		}
		function persistSpokenIds() {
			try {
				const arr = [...spokenIds];
				if (arr.length > SPOKEN_MAX) {
					spokenIds.clear();
					for (const id of arr.slice(-SPOKEN_MAX)) spokenIds.add(id);
				}
				sessionStorage.setItem(SPOKEN_KEY, JSON.stringify([...spokenIds]));
			} catch (e) { /* 忽略 */ }
		}
		if (typeof window !== "undefined") loadSpokenIds();

		function stopSpeaking() {
			if (window.speechSynthesis) window.speechSynthesis.cancel();
			state.speaking = false;
			if (state.setter) {
				state.setter(false);
				state.setter = null;
			}
			state.button = null;
		}

		/**
		 * 从按钮元素提取所在消息的正文文本（精华模式）。
		 *
		 * 原理：按钮位于 div[data-turn-tail]（动作条根）内，其直接父容器同时
		 * 包含这条消息的正文与动作条；取父容器文本减去动作条文本即为正文。
		 *
		 * 精华模式：只念叙述性正文 —— 跳过代码块、行内代码、项目符号/编号列表、
		 * 表格、可折叠工具卡片，只保留自然语言句子。
		 * @param {HTMLElement} buttonEl
		 * @returns {string}
		 */
		// 精华模式：这些标签内的文本不念（代码 / 列表 / 表格 / 折叠卡片）
		const TTS_ESSENCE = new Set(["PRE", "CODE", "UL", "OL", "TABLE", "DETAILS", "SUMMARY"]);
		// 硬分隔 = 消息边界：可折叠工具卡片（details/summary）或带 data-tool 的卡片
		const TTS_HARD = new Set(["DETAILS", "SUMMARY"]);
		// 块级边界：遇到这些标签在文本之间插入换行，避免词语粘连
		const TTS_BLOCK = new Set(["P", "DIV", "BR", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "SECTION", "ARTICLE", "TR"]);

		/** 统计某元素内文本长度（不含 data-turn-tail 动作条子树）。 */
		function textLenExcludingTail(el) {
			let n = 0;
			(function walk(node) {
				if (node.nodeType === Node.TEXT_NODE) {
					n += (node.nodeValue || "").length;
					return;
				}
				if (node.nodeType !== Node.ELEMENT_NODE) return;
				if (node !== el && node.hasAttribute && node.hasAttribute("data-turn-tail")) return;
				for (const child of node.childNodes) walk(child);
			})(el);
			return n;
		}

		/** 把消息的 blocks 拼成纯文本（只取 text 块）。 */
		function assistantText(blocks) {
			return (blocks || []).filter((b) => b.kind === "text").map((b) => b.text).join("");
		}

		/**
		 * 朗读前清洗：
		 * - 剥掉 Markdown 标记（**、`、#、>、链接语法）
		 * - 剥掉表情/装饰符号（✅→不会念"空闲对勾"）
		 * - **保留句子标点**（，。！？；：等）——引擎会用它停顿，但不会念出来
		 * - 顺序（BUG-022）：先剥链接/尖括号整体，再删装饰符，避免 `<https://…>` 残留裸 URL
		 */
		function cleanText(text) {
			return (text || "")
				.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
				.replace(/<[^>]*>/g, "")
				.replace(/[`*_#<>~]/g, "")
				.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu, "")
				.replace(/[ \t]+/g, " ")
				.replace(/\n{2,}/g, "\n")
				.trim();
		}

		/**
		 * 从会话投影读取指定 messageId 对应消息的正文。
		 * 这是前端渲染的原始数据源：最终助手消息的 blocks 就是那条回复的正文，
		 * 天然不含工具过程/叙述。
		 */
		function readFromProjection(sessionId, messageId) {
			if (!ttsCtx || !ttsCtx.sessions) return "";
			try {
				const session = ttsCtx.sessions.binding(sessionId)?.session;
				if (!session) return "";
				const snapshot = session.snapshotCache || session.buildSnapshot();
				const chat = snapshot && snapshot.chat;
				if (!chat || !chat.nodes) return "";
				let found = null;
				for (const node of chat.nodes.values()) {
					const data = node && node.data ? node.data : void 0;
					const fn = data ? data.finalNode : void 0;
					const closingFn = data && data.closing ? data.closing.finalNode : void 0;
					if ((fn && fn.messageId === messageId) || (closingFn && closingFn.messageId === messageId)) {
						found = fn && fn.messageId === messageId ? fn : closingFn;
						break;
					}
				}
				return found ? assistantText(found.blocks) : "";
			} catch (e) {
				console.warn("[dsh-tts] 投影读取异常", e);
				return "";
			}
		}

		/**
		 * 从会话投影取"最后一条最终消息"的 messageId（BUG-020）。
		 * 不再依赖 DOM 中 [data-turn-tail] 的数量判断最后一条，直接与自身比对。
		 */
		function getLatestAssistantMessageId(sessionId) {
			if (!ttsCtx || !ttsCtx.sessions) return "";
			try {
				const session = ttsCtx.sessions.binding(sessionId)?.session;
				if (!session) return "";
				const snapshot = session.snapshotCache || session.buildSnapshot();
				const chat = snapshot && snapshot.chat;
				if (!chat || !chat.nodes) return "";
				let latest = "";
				for (const node of chat.nodes.values()) {
					const data = node && node.data ? node.data : void 0;
					const fn = data ? data.finalNode : void 0;
					if (fn && fn.messageId) latest = fn.messageId;
					const closingFn = data && data.closing ? data.closing.finalNode : void 0;
					if (closingFn && closingFn.messageId) latest = closingFn.messageId;
				}
				return latest;
			} catch (e) {
				console.warn("[dsh-tts] 最新消息判定异常", e);
				return "";
			}
		}

		/** 读正文：优先投影（精确），失败退回 DOM 分段提取，最后清洗掉标点/表情。 */
		function readMessageText(messageId, sessionId, buttonEl) {
			let text = "";
			if (messageId) text = readFromProjection(sessionId, messageId);
			if (!text && buttonEl) text = extractMessageText(buttonEl);
			text = cleanText(text);
			console.info("[dsh-tts] %s %d 字: %s…", text ? "将朗读" : "提取为空", text.length, text.slice(0, 60));
			return text;
		}

		/**
		 * 从按钮元素提取"最后一条回复"的正文（精华模式）。
		 *
		 * 思路：上爬找包含正文的作用域（消息根或整个回合）；在其中做分段——
		 * 工具卡片/折叠卡片是"硬分隔"（消息边界），代码/列表/表格是"精华跳过"（不念但不算边界）；
		 * 只取**最后一个硬分隔之后**的正文 = 本回合最后一条回复，再做精华过滤。
		 * @param {HTMLElement} buttonEl
		 * @returns {string}
		 */
		function extractMessageText(buttonEl) {
			const tail = buttonEl.closest("[data-turn-tail]");
			if (!tail) {
				console.warn("[dsh-tts] 找不到 data-turn-tail 祖先");
				return "";
			}
			// 上爬找作用域：第一个含非动作条文本的祖先
			let scope = tail.parentElement;
			const trace = [];
			for (let i = 0; i < 10 && scope; i++) {
				const len = textLenExcludingTail(scope);
				trace.push(scope.tagName + "(" + len + ")");
				if (len >= 1) break;
				scope = scope.parentElement;
			}
			if (!scope) {
				console.warn("[dsh-tts] 无作用域; trace =", trace.join(" → "));
				return "";
			}
			// 分段：body（带 essence 标记）与 hard（消息边界）；动作条子树整体跳过
			const segs = [];
			(function walk(node, inEssence) {
				if (node.nodeType === Node.TEXT_NODE) {
					const t = (node.nodeValue || "").replace(/\s+/g, " ").trim();
					if (!t) return;
					const last = segs[segs.length - 1];
					if (last && last.kind === "body" && last.essence === inEssence) last.text += " " + t;
					else segs.push({ kind: "body", text: t, essence: inEssence });
					return;
				}
				if (node.nodeType !== Node.ELEMENT_NODE) return;
				const el = node;
				if (el.hasAttribute("data-turn-tail")) return;
				if (el.hasAttribute("data-tool") || el.hasAttribute("data-tool-call") || TTS_HARD.has(el.tagName)) {
					segs.push({ kind: "hard" });
					return;
				}
				const childEssence = inEssence || TTS_ESSENCE.has(el.tagName);
				for (const child of el.childNodes) walk(child, childEssence);
				if (TTS_BLOCK.has(el.tagName)) segs.push({ kind: "sep" });
			})(scope, false);

			// 最后一个 hard（消息边界）之后的正文 = 最后一条回复
			let lastHard = -1;
			for (let i = segs.length - 1; i >= 0; i--) {
				if (segs[i].kind === "hard") {
					lastHard = i;
					break;
				}
			}
			const prose = [];
			const any = [];
			for (let i = lastHard + 1; i < segs.length; i++) {
				if (segs[i].kind !== "body") continue;
				any.push(segs[i].text);
				if (!segs[i].essence) prose.push(segs[i].text);
			}
			let text = (prose.length ? prose : any).join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
			if (!text) {
				console.warn("[dsh-tts] 提取为空; trace =", trace.join(" → "), "; 段序 =", segs.map((s) => s.kind).join(","), "; 作用域 outerHTML 前300字 =", (scope.outerHTML || "").slice(0, 300));
			} else {
				console.info("[dsh-tts] 将朗读 %d 字: %s…", text.length, text.slice(0, 60));
			}
			return text;
		}

		/**
		 * 朗读预设：性别 × 风格（每项 = 语音偏好 + 默认语速 + 默认音高）。
		 * 8 项普通话 + 1 项四川话（REQ-010），共 9 项；下拉由本表自动渲染，加一项即出现在设置页。
		 */
		const VOICE_PRESETS = [
			{ id: "female-calm",   label: "女声 · 平静", voice: ["晓伊", "xiaoyi"],   rate: 1.0, pitch: 0 },
			{ id: "female-gentle", label: "女声 · 温柔", voice: ["晓伊", "xiaoyi"],   rate: 0.9, pitch: 2 },
			{ id: "female-lively", label: "女声 · 活泼", voice: ["晓晓", "xiaoxiao"], rate: 1.2, pitch: 5 },
			{ id: "female-intel",  label: "女声 · 知性", voice: ["晓晓", "xiaoxiao"], rate: 1.0, pitch: 1 },
			{ id: "male-calm",     label: "男声 · 沉稳", voice: ["云希", "yunxi"],    rate: 0.8, pitch: -3 },
			{ id: "male-sunny",    label: "男声 · 阳光", voice: ["云希", "yunxi"],    rate: 1.1, pitch: 2 },
			{ id: "male-velvet",   label: "男声 · 磁性", voice: ["云扬", "yunyang"],  rate: 0.9, pitch: -2 },
			{ id: "male-crisp",    label: "男声 · 干练", voice: ["云扬", "yunyang"],  rate: 1.0, pitch: 0 },
			// REQ-010：四川话预设。dialect 标记让 pickPresetVoice 优先去找 zh-CN-Sichuan 系语音
			// （Edge 在线语音「云希（四川话）」zh-CN-Sichuan-Yunxi）；宿主没有时走普通话回退链。
			// 仅男声：Web Speech API 内无四川话女声，女声需第三方云 TTS，与「零依赖/零网络」定位冲突 → 该 REQ 列为待评估、不实现。
			// rate 0.95 / pitch −1：故意避开已有 8 项的语速音高组合（男声·干练是 1.0/0），
			// 满足「自带默认语速音高、听感与普通话预设可区分」这条验收。
			{ id: "male-sichuan", label: "男声 · 四川", voice: ["云希", "yunxi"],    rate: 0.95, pitch: -1, dialect: "sichuan" }
		];
		/** 设置默认值。 */
		// REQ-009：processNarration = 过程播报开关，默认关（只想听结果的用户保持默认即可）。
		// loadPersistedSettings 按 DEFAULT_SETTINGS 的 key 过滤，老用户的 localStorage 里没这个键 → 取默认 false。
		const DEFAULT_SETTINGS = { preset: "female-calm", rate: 1.0, pitch: 0, autoPlay: false, processNarration: false };

		const normVoice = (s) => String(s).toLowerCase().replace(/\s+/g, "");
		const clampNum = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
		let zhVoice = null;
		/** REQ-010：语音选择诊断日志（同一结论只打一次，避免过程播报逐段刷屏）。 */
		let lastVoiceLog = "";
		function logVoicePick(msg) {
			if (msg === lastVoiceLog) return;
			lastVoiceLog = msg;
			console.info("[dsh-tts] 语音: %s", msg);
		}
		/**
		 * REQ-010：判定一个语音是否为四川话语音。
		 * 主判据：lang 以 `zh-cn-sichuan` 开头（Edge 在线语音的 zh-CN-Sichuan）；
		 * 兜底判据：名字或 lang 里含 sichuan / 四川（不同宿主命名不统一）。
		 */
		function isSichuanVoice(v) {
			if (!v) return false;
			const lang = String(v.lang || "").toLowerCase();
			const name = String(v.name || "").toLowerCase();
			if (lang.startsWith("zh-cn-sichuan")) return true;
			return /sichuan|四川/.test(name) || /sichuan|四川/.test(lang);
		}
		/**
		 * 按预设挑语音：优先预设内候选名，找不到再兜底自然语音/任意中文语音。
		 * REQ-010：
		 * - 四川话预设（dialect === "sichuan"）先在**全部** voices 里找四川话语音，命中即用；
		 * - 普通话预设的中文池**剔掉**四川话语音——否则「云希」模糊匹配可能选到「云希（四川话）」，
		 *   让普通话预设念出四川口音（回归风险）。四川话语音只归四川话预设专用。
		 * - 四川话预设找不到四川话语音时，走与普通话完全相同的回退链，保证「无方言语音也照常能读、不报错」。
		 */
		function pickPresetVoice(presetId) {
			const preset = VOICE_PRESETS.find((p) => p.id === presetId) || VOICE_PRESETS[0];
			if (!window.speechSynthesis) return;
			const voices = window.speechSynthesis.getVoices();
			if (!voices.length) return;
			// REQ-010：方言预设优先命中方言语音（不受下面「中文池」的 zh- 前缀/剔除规则影响）
			if (preset.dialect === "sichuan") {
				const dialectHit = voices.find(isSichuanVoice);
				if (dialectHit) {
					zhVoice = dialectHit;
					// 实测要确认「是否真用上了四川话语音」，故留一条诊断；去重后每次换语音才打一行
					// （startSpeaking 每段都会调本函数，过程播报下不去重会刷屏）。
					logVoicePick("四川话命中 " + dialectHit.name + " (" + dialectHit.lang + ")");
					return;
				}
				logVoicePick("宿主无四川话语音，回退普通话（宿主兼容限制，非插件缺陷）");
			}
			// REQ-010：中文池排除四川话语音，避免普通话预设误选方言语音
			let zh = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("zh") && !isSichuanVoice(v));
			// REQ-010：极端兜底——宿主的中文语音**全是**方言时，宁可用方言语音，
			// 也别把 zhVoice 置空退到引擎默认（可能是非中文语音）。
			if (!zh.length) zh = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("zh"));
			if (!zh.length) {
				zhVoice = null;
				return;
			}
			for (const cand of preset.voice) {
				const target = normVoice(cand);
				const hit = zh.find((v) => normVoice(v.name).includes(target));
				if (hit) {
					zhVoice = hit;
					return;
				}
			}
			zhVoice = zh.find((v) => /online|natural|neural|云|晓/i.test(v.name)) || zh[0];
		}
		if (typeof window !== "undefined" && window.speechSynthesis) {
			pickPresetVoice(DEFAULT_SETTINGS.preset);
			window.speechSynthesis.addEventListener("voiceschanged", () => pickPresetVoice(readSettings().preset));
		}

		/** 设置持久化：localStorage（第三方插件位置无法 import 宿主 settings 依赖，故用浏览器本地存储——零宿主改动、刷新即生效）。 */
		const LS_SETTINGS_KEY = "dsh-tts-reader.settings";
		let settingsSnap = { ...DEFAULT_SETTINGS };
		/** 内存覆盖：本次会话的修改，界面/朗读即刻生效。 */
		const memOverrides = {};
		const settingsListeners = new Set();
		function loadPersistedSettings() {
			try {
				const raw = localStorage.getItem(LS_SETTINGS_KEY);
				if (raw) {
					const v = JSON.parse(raw);
					const out = {};
					for (const k of Object.keys(DEFAULT_SETTINGS)) if (typeof v[k] !== "undefined") out[k] = v[k];
					return out;
				}
			} catch (e) { /* 忽略 */ }
			return {};
		}
		function savePersistedSettings(settings) {
			try { localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
		}
		function mergeSettings() {
			settingsSnap = { ...DEFAULT_SETTINGS, ...loadPersistedSettings(), ...memOverrides };
			// REQ-009：过程播报依赖自动播放（processNarration ⟹ autoPlay）
			// 读时钳制：无论走哪条路径（默认 / localStorage 旧脏数据 / 本次会话内存覆盖），
			// autoPlay 一关，processNarration 立刻失效——不必在写入侧逐处补条件。
			settingsSnap.processNarration = !!(settingsSnap.processNarration && settingsSnap.autoPlay);
		}
		function publishSettings() {
			for (const l of [...settingsListeners]) l();
		}
		function subscribeSettings(listener) {
			settingsListeners.add(listener);
			return () => settingsListeners.delete(listener);
		}
		/** 读当前设置（默认 ← localStorage ← 本次会话修改）。 */
		function readSettings() {
			return settingsSnap;
		}
		/** 批量写设置：一次 merge + 一次保存 + 一次发布（BUG-019，避免连调多次 writeSetting）。 */
		function writeSettings(patch) {
			Object.assign(memOverrides, patch);
			mergeSettings();
			savePersistedSettings(settingsSnap);
			publishSettings();
		}
		/** 写设置：立即进内存（界面/朗读即刻生效）+ 写入 localStorage 持久化。 */
		function writeSetting(field, value) {
			writeSettings({ [field]: value });
		}
		if (typeof window !== "undefined") mergeSettings();

		/** 真正开始朗读（手动点击与自动播放共用）。 */
		function startSpeaking(text, el, setSpeaking) {
			if (window.speechSynthesis) window.speechSynthesis.cancel();
			// BUG-013：切换朗读时先复位旧按钮的"正在读"态，避免 A 按钮卡在 ⏹
			if (state.setter && state.button !== el) {
				state.setter(false);
				state.setter = null;
			}
			const s = readSettings();
			pickPresetVoice(s.preset);
			const u = new SpeechSynthesisUtterance(text);
			// REQ-010：u.lang 跟随所选语音的 lang，不再硬编码 "zh-CN"——
			// 方言语音的 lang 是 zh-CN-Sichuan，写死 zh-CN 会与语音自身语言矛盾，可能让引擎退回普通话发音。
			// 没挑到语音时（宿主无中文语音）仍给 zh-CN 兜底，让引擎按中文尽力发音。
			if (zhVoice) {
				u.voice = zhVoice;
				u.lang = zhVoice.lang || "zh-CN";
			} else {
				u.lang = "zh-CN";
			}
			u.rate = clampNum(0.5, 2, s.rate ?? 1);
			u.pitch = clampNum(0, 2, 1 + (s.pitch ?? 0) / 10);
			// BUG-014：Chrome/Edge 长文本约 15s 后静音，定时 resume 保活（随 done 一起清理）
			let keepAliveTimer = null;
			if (window.speechSynthesis) {
				keepAliveTimer = setInterval(() => {
					try { window.speechSynthesis.resume(); } catch (e) { /* 忽略 */ }
				}, 8000);
			}
			const done = () => {
				if (keepAliveTimer) {
					clearInterval(keepAliveTimer);
					keepAliveTimer = null;
				}
				state.speaking = false;
				if (state.button === el) state.button = null;
				if (state.setter === setSpeaking) {
					setSpeaking(false);
					state.setter = null;
				}
			};
			u.onend = done;
			u.onerror = (e) => {
				// BUG-015：区分错误类型——用户主动打断/取消静默，其余告警；done 照常执行
				const err = e && e.error;
				if (!err || /interrupted|canceled/i.test(String(err))) {
					// 用户主动停止触发，非异常
				} else {
					console.warn("[dsh-tts] 朗读错误", e);
				}
				done();
			};
			state.speaking = true;
			state.button = el;
			state.setter = setSpeaking;
			setSpeaking(true);
			if (window.speechSynthesis) window.speechSynthesis.speak(u);
		}

		// ===== REQ-009：过程播报（Agent 干活期间实时朗读叙述性步骤）=====
		//
		// 数据源：会话快照里 status === 'running' 的助手行——它的 data.blocks 随流式输出
		// 增长（定稿后才有 data.finalNode.blocks，那条归自动播放/手动按钮管）。只读
		// kind === 'text' 的块：reasoning 是思考（界面默认折叠，不是讲给用户听的步骤）。
		// 非助手行（tool 行 data.root、turn-tail 行 data.closing 等）没有同构的 blocks/status，
		// 靠 Array.isArray(data.blocks) 挡掉。

		/** 监控轮询间隔：800ms —— 比一句话的生成时间短，又不至于每帧扫快照。 */
		const PROC_TICK_MS = 800;
		/** 句子终止符：出现即可成句（避免把半句话丢给引擎）。 */
		const PROC_SENTENCE_END = /[。！？；：.!?]/;
		/** 成句最短长度：太短的碎片（如单个"好"）攒着，别一个词一个词地蹦。
		 *  【听感旋钮】BUG-025 精修轮保持 8：再小就会念出"明白，"这类碎片。 */
		const PROC_MIN_SENTENCE = 8;
		/** 无标点长句的强制切块长度。
		 *  【听感旋钮】BUG-025 精修轮 60 → 90：切段次数越少，段间缝隙越少（每段都要重新
		 *  cancel+speak，缝隙就是用户说的"卡顿感"）。代价是无标点长句的实时性略降。 */
		const PROC_MAX_CHUNK = 90;
		/** 流停顿多久算"这段说完了"，把尾巴念出去。 */
		const PROC_IDLE_MS = 1200;
		/** 新节点**首句**的兜底冲刷阈值（BUG-025 精修轮）：首句本该等成句再念，
		 *  但模型可能卡住 / 首块干脆没标点——停这么久就算没成句也念出去，避免永远不出声。 */
		const PROC_FIRST_IDLE_MS = 2500;

		/**
		 * 过程播报的增量指针（模块级，跨 tick 存活）。
		 * key      = sessionId#turn:step，用来识别"还是同一个 running step"
		 * sessionId= 当前这份 proc 状态属于哪个会话（BUG-026：跨会话判定用；null = 还没跟过任何会话）
		 * spokenLen= 已进入 buffer 的 liveText 长度（增量起点）
		 * buffer   = 攒着还没念出去的文本
		 * lastGrowAt = 上次拿到增量的时刻（判断流是否停了）
		 * firstPending = 这个节点还没念出过任何一段（BUG-025 精修轮：首句走"必须成句"的严规则）
		 * blockedKey = 因引擎占用而让路中的 key（仅用于诊断日志去重）
		 *
		 * 注：BUG-025 首版的 `playingKey`（正在播的那段属于哪个 key）已在精修轮**删除** ——
		 * 它唯一的用途是"在播的是旧节点就立刻打断"，而这正是用户反馈的卡顿来源。
		 *
		 * BUG-026：`key` 里虽然已含 sessionId，但仍单列 `sessionId` 字段 —— 判定"是否换了会话"
		 * 要在拿到 running 行**之前**就做（切走的一瞬间旧会话可能已经没有可见的 running 行，
		 * 且新会话的 key 还没算出来），而且能正确处理"同一 turn 内切走又切回"。
		 */
		const proc = { key: null, sessionId: null, spokenLen: 0, buffer: "", lastGrowAt: 0, firstPending: true, blockedKey: null };
		/**
		 * BUG-026 弃用表：sessionId → 被弃用的轮次（turn）。
		 * 语义："用户在这个会话正播着的时候切走了，那一轮（及更早）的内容不要再念了"。
		 * 只在**切走时该会话确实在播**（`proc.key` 非空）才记 —— 从没读过 / 早已播完的会话，
		 * 切走不记弃用，日后切回若它在播属"新遭遇"，正常读。
		 * 解除条件：该会话出现 `turn > 弃用轮次` 的 running 行（= 用户在那边开了新一轮，说明又想听了）。
		 */
		const abandonedTurns = new Map();
		/** 弃用表条目上限（同 BUG-016 的克制：表只是"别再念"的备忘，不必无限增长）。 */
		const ABANDONED_MAX = 50;
		function markAbandoned(sessionId, turn) {
			abandonedTurns.delete(sessionId);
			abandonedTurns.set(sessionId, turn);
			while (abandonedTurns.size > ABANDONED_MAX) {
				const oldest = abandonedTurns.keys().next().value;
				abandonedTurns.delete(oldest);
			}
		}
		/** 从 `sessionId#turn:step` 形态的 key 里解析出 turn；解析不出返回 null。 */
		function turnOfKey(key) {
			if (!key) return null;
			const hash = String(key).lastIndexOf("#");
			if (hash < 0) return null;
			const rest = String(key).slice(hash + 1);
			const colon = rest.indexOf(":");
			const turn = colon < 0 ? rest : rest.slice(0, colon);
			return turn === "" ? null : turn;
		}
		/**
		 * 当前 running 行的 turn 是否"仍在被弃用的那一轮（或更早）"。
		 * turn 在宿主里通常是数字，但 key 解析出来是字符串：两边都能转数字就按数字比，
		 * 否则退回字符串严格相等 —— 认不出新旧时宁可判成同一轮（静默），也不要误开口念旧内容。
		 */
		function isAbandonedTurn(turn, abandoned) {
			const a = Number(turn);
			const b = Number(abandoned);
			if (Number.isFinite(a) && Number.isFinite(b)) return a <= b;
			return String(turn) === String(abandoned);
		}
		// BUG-025（症状①「念完又退回重念」的根因）：过程段的 setSpeaking **必须每段新建闭包**，
		// 绝不可再退回用一个稳定的 noop。稳定引用会让 startSpeaking 内 done() 的
		// `state.setter === setSpeaking` 身份校验**恒真**：新段 startSpeaking 先 cancel 旧段 →
		// 旧段迟到的 onerror(interrupted) 触发 done() → 把**正在播的新段** state 清成空闲 →
		// 下个 tick 误判引擎空闲、再 cancel 新段从头念 → 听感就是片段反复重念/退回。
		// 每段一个新闭包后，旧段的 done() 因 setter 身份对不上而只清自己（no-op），新段状态完好。
		/** BUG-025 诊断日志开关（临时打开，用户实测确认后再关）。 */
		const PROC_DEBUG = true;
		function procLog(...args) {
			if (PROC_DEBUG) console.info("[dsh-tts][proc]", ...args);
		}
		let procTimer = null;

		/** 重置增量指针（换节点 / 换会话 / 关开关时）。
		 *  BUG-025 精修轮：把 firstPending 置回 true —— 下一个节点的第一句要重新走"成句才念"的严规则。
		 *  BUG-026：**不动 `proc.sessionId`** —— 它记的是"这份状态跟着哪个会话"，由 tick 里的
		 *  会话切换分支统一维护；在这里清掉会让下一拍误判成"首次加载"，切换语义就失效了。 */
		function resetProc() {
			proc.key = null;
			proc.spokenLen = 0;
			proc.buffer = "";
			proc.lastGrowAt = 0;
			proc.firstPending = true;
		}

		/** 找当前正在 running 的助手行；nodes 是 Map（插入序），取最后一个 = turn/step 最新。 */
		function findRunningAssistant(chat) {
			let found = null;
			for (const node of chat.nodes.values()) {
				const data = node && node.data ? node.data : void 0;
				if (!data || !Array.isArray(data.blocks) || data.status !== "running") continue;
				found = data;
			}
			return found;
		}

		/**
		 * 试着把 buffer 念出去。
		 * 返回 true = 已处理（念了 / 清洗后为空丢弃）；false = 让路，buffer 原样留到下个 tick。
		 *
		 * REQ-009 交互契约 + BUG-025 精修轮的**单档门控**：引擎彻底空闲才开口。
		 * - `state.button !== null` —— 有按钮元素 = 用户手动点的朗读或定稿消息的自动播放，
		 *   **一律让路，绝不打断**（抢占还会触发 BUG-013 分支把对方按钮的 ⏹ 态复位）。
		 * - `state.setter !== null` —— 有过程段正在播，同样让路，等它自然念完。
		 *
		 * BUG-025 精修轮（用户原话：「我宁愿你响应慢一点，也不要有那一段卡顿的感觉」）：
		 * 宁可慢但顺——绝不在词中间掐断正在播的段，切换等自然结束。首版为"立即切换"开的
		 * 「playingKey 是旧节点 → 直接 cancel 打断」这条激进路径已删除：startSpeaking 开头的
		 * cancel 会把正在播的半句话硬生生截断，听感就是用户说的"卡顿一下"。
		 * 切换仍然会发生，只是变平滑：换节点时 resetProc 已把 proc.key 指向新节点、spokenLen 归零，
		 * 旧段一结束（state.setter 回 null），下个 tick（≤800ms）冲刷的就是**新节点**的内容。
		 * 代价：切换最多晚一段的时长（几秒），换来全程不掐字——这是用户明确选择的取舍。
		 */
		function speakProcBuffer() {
			// BUG-025 精修轮：按钮朗读、过程段在播，一律让路，等自然结束
			if (state.button !== null || state.setter !== null) return false;
			const bufLen = proc.buffer.length;
			const text = cleanText(proc.buffer);
			proc.buffer = "";
			if (text) {
				procLog("冲刷·说", { key: proc.key, firstPending: proc.firstPending, spokenLen: proc.spokenLen, "buffer长度": bufLen, "长度": text.length, "文本": text.slice(0, 40) });
				// 这个节点开过口了，后续片段回到常规切块规则（句尾 / 90 字 / 停 1.2s）
				proc.firstPending = false;
				// BUG-025：每段一个**新建**的空闭包做 setSpeaking（不是共享的稳定引用），
				// 让 startSpeaking 的 done() 身份校验按段生效——旧段迟到的回调清不掉新段状态。
				startSpeaking(text, null, () => {});
			}
			return true;
		}

		/**
		 * 冲刷判据（满足其一就试着说）：
		 * a. 已成句（含句尾标点且够长）；b. 攒够 90 字（无标点长句）；c. 流停了 1.2s（念尾巴）。
		 * 注：引擎忙时 buffer 会继续涨，但 b 一旦成立就每个 tick 都返回 true，
		 *    引擎一空闲立刻冲刷 —— 不会无限积压。
		 *
		 * BUG-025 精修轮 —— **首句规则**（proc.firstPending，即这个节点还没开过口）：
		 * 只认 a（成句），不认 b、不认 c。原因：一个节点的开头最容易被 c 规则切出
		 * "明白，"这种碎片，念完立刻停、再接下一段 → 用户听到的就是"第一句话卡顿一下"。
		 * 首句攒到真正成句再开口，宁可晚半秒也要一口气顺下来。
		 * 唯一例外是 PROC_FIRST_IDLE_MS(2.5s) 兜底：流停这么久说明模型卡住 / 这块本就没标点，
		 * 再等下去就是"永远不出声"，此时照念。
		 */
		function shouldFlushProc(now) {
			const buf = proc.buffer;
			if (!buf) return false;
			const sentence = PROC_SENTENCE_END.test(buf) && buf.trim().length >= PROC_MIN_SENTENCE;
			if (proc.firstPending) {
				if (sentence) return true;
				if (proc.lastGrowAt && now - proc.lastGrowAt > PROC_FIRST_IDLE_MS) return true;
				return false;
			}
			if (sentence) return true;
			if (buf.length >= PROC_MAX_CHUNK) return true;
			if (proc.lastGrowAt && now - proc.lastGrowAt > PROC_IDLE_MS) return true;
			return false;
		}

		/** 一次轮询：取 running 助手行 → 算增量 → 按判据冲刷。整体包 try/catch，绝不让监控器崩掉页面。 */
		function tickProcessNarration() {
			try {
				if (!readSettings().processNarration) {
					// 开关关着：连同残留增量一起丢弃（不朗读），免得下次开启时突然念旧文本
					// BUG-026：会话归属与弃用表一并清空 —— 重新开启时等同"首次加载"，不会因为
					// 关闭期间切过会话而在下一拍误判成"会话切换"去 stopSpeaking（那会掐掉用户手动的朗读）。
					if (proc.key || proc.buffer || proc.sessionId || abandonedTurns.size) {
						resetProc();
						proc.sessionId = null;
						proc.blockedKey = null;
						abandonedTurns.clear();
					}
					return;
				}
				if (!ttsCtx || !ttsCtx.sessions) return;
				// 当前会话 id 走 ObservableSnapshot 契约；face 缺失时静默跳过（每 800ms 一次，别刷 console）
				const list = ttsCtx.sessions.list;
				if (!list || typeof list.getSnapshot !== "function") return;
				const sessionId = list.getSnapshot()?.current;
				if (!sessionId) return;
				// ===== BUG-026 ①「切走即停」=====
				// 用户切到别的会话 = 明确表示「我既然这边已经开新会话了，肯定就不想再听那边老的没播完的内容」。
				// 三件事一起做，且必须在读 running 行**之前**做（切走的一瞬间旧会话的节点可能已不在当前快照里）：
				//   1) stopSpeaking()：停掉旧会话正在播的过程段 / 按钮朗读（引擎本就空闲时 cancel 是无害 no-op）；
				//   2) resetProc()：**直接丢弃**旧会话没念的尾巴 —— 这里**不走** speakProcBuffer 强制冲刷，
				//      跨会话不念旧尾巴（同会话换 step 的强制冲刷是 BUG-025 的既定行为，见下方 key 变更分支，未动）；
				//   3) 旧会话当时确实在播（proc.key 非空 → turnOfKey 能解析出轮次）才记进弃用表，回落时不再续读。
				// proc.sessionId 初始为 null（首次加载）→ 不算切换，不会误 stop。
				if (proc.sessionId !== null && proc.sessionId !== sessionId) {
					const oldSessionId = proc.sessionId;
					const oldTurn = turnOfKey(proc.key);
					// 旧轮次 = null → 旧会话当时并没在播过程播报，只 stop 不记弃用（日后切回属"新遭遇"，正常读）
					procLog("会话切换·停止并弃用", { "旧会话": oldSessionId, "新会话": sessionId, "旧轮次": oldTurn, "记弃用": oldTurn !== null, "buffer长度": proc.buffer.length });
					stopSpeaking();
					resetProc();
					proc.blockedKey = null;
					if (oldTurn !== null) markAbandoned(oldSessionId, oldTurn);
				}
				proc.sessionId = sessionId;
				const session = ttsCtx.sessions.binding(sessionId)?.session;
				if (!session) return;
				// BUG-025（症状②「还在念旧内容」的根因之一）：snapshotCache 是事件驱动缓存，
				// 新消息/新 step 刚出现时可能还是上一拍的节点集 → 监控器晚一步才看到新节点。
				// 这里每 tick 强制重建快照（纯内存计算，800ms 一次开销可忽略），保证看到最新节点。
				// typeof 守卫：buildSnapshot / snapshotCache 都属宿主内部实现，缺失时退回缓存而非抛异常刷屏。
				const snapshot = typeof session.buildSnapshot === "function" ? session.buildSnapshot() : session.snapshotCache;
				const chat = snapshot && snapshot.chat;
				if (!chat || !chat.nodes) return;
				const data = findRunningAssistant(chat);
				// ===== BUG-026 ②「被弃用的会话不自动续读」/ ③「新一轮恢复」=====
				// 必须早于下面的 key 逻辑：否则被弃用会话的 running 行会照常进 key 变更分支、
				// spokenLen 归零从头重念 —— 那正是本 bug 的症状（B 念完、current 回落 A → A 被整体重读）。
				// !data：这一拍还看不到 running 行，什么都不做，等下一拍再判（别急着解除弃用）。
				if (abandonedTurns.has(sessionId)) {
					if (!data) return;
					const abandonedTurn = abandonedTurns.get(sessionId);
					// 还是被弃用的那一轮（或更早）→ 静默跳过。这里**不打日志**：每 800ms 一次会刷屏。
					if (isAbandonedTurn(data.turn, abandonedTurn)) return;
					// 该会话开了新一轮 = 用户又在那边干活了 → 解除弃用，恢复播报
					abandonedTurns.delete(sessionId);
					procLog("会话新轮·恢复", { sessionId: sessionId, turn: data.turn, "弃用轮次": abandonedTurn });
				}
				const key = data ? sessionId + "#" + data.turn + ":" + data.step : null;
				if (key !== proc.key) {
					// running 行换了（上一 step 定稿 / 进入工具执行期）：先把余量说完再重置指针。
					// BUG-026：**跨会话**切换已在 tick 上方被接管（停 + 丢尾巴 + 记弃用，buffer 那时已清空），
					// 所以这里的强制冲刷实际只服务**同一会话内**的 step 切换 —— 前几轮"尾巴不吞字"的行为原样保留。
					// 这里的 speakProcBuffer() 是**强制冲刷**（不过 shouldFlushProc），保证上一节点的尾巴
					// 不被吞掉；让路（引擎在播：用户手动朗读 / 上一段过程还没念完）就整个 tick 不动，
					// 下个 tick 再来 —— 保证过程语句按发生顺序念出。
					const info = { "旧key": proc.key, "新key": key, "buffer长度": proc.buffer.length, spokenLen: proc.spokenLen, firstPending: proc.firstPending };
					if (proc.buffer && !speakProcBuffer()) {
						// 同一次让路只记一条日志，别每 800ms 刷屏（BUG-025 诊断期）
						if (proc.blockedKey !== key) {
							procLog("key 变更但让路（引擎在播，等自然结束）", info);
							proc.blockedKey = key;
						}
						return;
					}
					procLog("key 变更", info);
					proc.blockedKey = null;
					resetProc();
					proc.key = key; // key 可能是 null（当前没有 running 行）
					// BUG-025 精修轮：不打断正在播的旧段。旧段自然念完后 state.setter 回 null，
					// 下个 tick 冲刷的已经是新节点的内容（spokenLen 归零、firstPending 回 true）→ 切换平滑。
				}
				if (!data) return;
				const liveText = assistantText(data.blocks);
				// BUG-025：同一节点文本**收缩** = 这个 step 被重置/重试（resetForRetry），
				// 界面上已是全新内容。此时旧的 spokenLen 会把新文本整段跳过（听感 = 还在念旧的、
				// 或干脆不出声），故视为新内容：指针归零从头念。
				// 精修轮：firstPending 回 true（重来的内容等同新节点，第一句照样要成句才念）；
				// 不再碰 playingKey（已删）——正在播的旧段仍等它自然念完，不掐断。
				if (liveText.length < proc.spokenLen) {
					procLog("文本收缩(重试) → 从头念", { key: proc.key, liveLen: liveText.length, spokenLen: proc.spokenLen, "buffer长度": proc.buffer.length });
					proc.spokenLen = 0;
					proc.buffer = "";
					proc.firstPending = true;
				}
				const delta = liveText.slice(proc.spokenLen);
				if (delta) {
					proc.buffer += delta;
					proc.spokenLen = liveText.length;
					proc.lastGrowAt = Date.now();
				}
				if (shouldFlushProc(Date.now())) speakProcBuffer();
			} catch (e) {
				console.warn("[dsh-tts] 过程播报监控异常", e);
			}
		}

		/** 启动监控器（模块级定时器，不依赖任何组件挂载；重复调用幂等）。 */
		function startProcessNarrationMonitor() {
			if (procTimer || typeof window === "undefined") return;
			procTimer = setInterval(tickProcessNarration, PROC_TICK_MS);
		}

		// ENH-006/007：SVG 矢量图标（替换 emoji），16×16 网格、全轮廓描边（strokeWidth 1.4、圆头），
		// 对齐宿主导入图标（复制/分支/刷新）视觉语言；currentColor 继承按钮 color。
		// v3（ENH-007）：图形放大顶格。宿主 16px 图标内容占满 0.25~15.8（约 97%），
		// v2 只占 2.7~13.6（约 68%）→ 并排显得瘦一圈。此版把含描边包围盒撑到 ~0.5~15.4。
		const PlayIcon = () => react_jsx_runtime.jsx("svg", {
			width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
			xmlns: "http://www.w3.org/2000/svg", "aria-hidden": true,
			children: [
				react_jsx_runtime.jsx("path", { d: "M1.1 5.5v5h2.4l4.3 4.1V1.4L3.5 5.5H1.1z", stroke: "currentColor", strokeWidth: 1.4, strokeLinejoin: "round" }),
				react_jsx_runtime.jsx("path", { d: "M10 5a3.9 3.9 0 0 1 0 6", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
				react_jsx_runtime.jsx("path", { d: "M12 2.6a6.6 6.6 0 0 1 0 10.8", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" })
			]
		});
		const StopIcon = () => react_jsx_runtime.jsx("svg", {
			width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
			xmlns: "http://www.w3.org/2000/svg", "aria-hidden": true,
			children: react_jsx_runtime.jsx("rect", { x: 1.5, y: 1.5, width: 13, height: 13, rx: 3.4, stroke: "currentColor", strokeWidth: 1.4 })
		});

		/** 单条消息的播放/停止按钮。 */
		function TtsButton(props) {
			const [speaking, setSpeaking] = react.useState(false);
			const btnRef = react.useRef(null);

			// 自动播放：开启时，若这是最后一条已定稿消息且这条还没自动读过 → 自动开读
			react.useEffect(() => {
				if (!props.messageId) return;
				if (!readSettings().autoPlay) return;
				if (spokenIds.has(props.messageId)) return;
				const el = btnRef.current;
				if (!el) return;
				// BUG-020：不再依赖 DOM 中 [data-turn-tail] 的数量判断最后一条，
				// 改为拿投影里最新消息的 messageId 与自身比对，避免虚拟滚动/并发渲染误判
				const latestId = getLatestAssistantMessageId(props.sessionId);
				if (!latestId || latestId !== props.messageId) return;
				const id = setTimeout(() => {
					if (spokenIds.has(props.messageId)) return;
					spokenIds.add(props.messageId);
					persistSpokenIds();
					const text = readMessageText(props.messageId, props.sessionId, btnRef.current);
					if (text) startSpeaking(text, btnRef.current, setSpeaking);
				}, 400);
				return () => clearTimeout(id);
			}, [props.messageId]);

			const toggle = () => {
				if (speaking) {
					stopSpeaking();
					return;
				}
				const el = btnRef.current;
				if (!el) return;
				const text = readMessageText(props.messageId, props.sessionId, el);
				if (!text) {
					// BUG-017：不用阻塞式 alert，改非阻塞 console 提示（宿主 toast 可另行接入）
					console.warn("[dsh-tts] 未能提取到这条消息的文本，无法朗读。（F12 控制台有诊断信息）");
					return;
				}
				startSpeaking(text, el, setSpeaking);
			};

			return react_jsx_runtime.jsx("button", {
				ref: btnRef,
				type: "button",
				title: speaking ? "停止朗读" : "朗读本条消息",
				"aria-label": speaking ? "停止朗读" : "朗读本条消息",
				onClick: toggle,
				style: {
					width: 28,
					height: 28,
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					cursor: "pointer",
					background: "none",
					border: "none",
					fontSize: 13,
					lineHeight: 1,
					// ENH-007：颜色对齐宿主导入图标（computed rgb(129,133,140)），非默认次级灰 rgb(97,102,107)
					color: "rgb(129, 133, 140)",
					padding: 0
				},
				children: speaking ? react_jsx_runtime.jsx(StopIcon, {}) : react_jsx_runtime.jsx(PlayIcon, {})
			});
		}

		/** 设置页组件：语音风格预设 + 语速/音高(−/+/滑杆) + 自动播放。 */
		function TtsSettingsTab() {
			const s = react.useSyncExternalStore(subscribeSettings, () => settingsSnap);
			const preset = s.preset ?? DEFAULT_SETTINGS.preset;
			const rate = s.rate ?? DEFAULT_SETTINGS.rate;
			const pitch = s.pitch ?? DEFAULT_SETTINGS.pitch;
			const autoPlay = s.autoPlay ?? DEFAULT_SETTINGS.autoPlay;
			// REQ-009：过程播报开关
			const processNarration = s.processNarration ?? DEFAULT_SETTINGS.processNarration;
			const onPreset = (id) => {
				const p = VOICE_PRESETS.find((x) => x.id === id);
				if (!p) return;
				// BUG-019：一次批量写（一次渲染 + 一次保存），而非三次 writeSetting
				writeSettings({ preset: id, rate: p.rate, pitch: p.pitch });
			};
			const ctl = { fontSize: 13, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, rgba(128,128,128,.45))", background: "var(--dsw-alias-surface, transparent)", color: "var(--dsw-alias-label-primary)" };
			const row = (label, control) => react_jsx_runtime.jsx("div", {
				style: { display: "grid", gridTemplateColumns: "88px 1fr", alignItems: "center", gap: 12 },
				children: [
					react_jsx_runtime.jsx("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-primary)" }, children: label }),
					control
				]
			});
			const stepBtn = (ch, onClick, title) => react_jsx_runtime.jsx("button", {
				type: "button", title, onClick,
				style: { width: 24, height: 24, flex: "0 0 auto", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, rgba(128,128,128,.45))", background: "transparent", color: "var(--dsw-alias-label-primary)", cursor: "pointer", fontSize: 14, lineHeight: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0 },
				children: ch
			});
			const slider = (label, value, min, max, step, onChange, display) => row(label, react_jsx_runtime.jsx("div", {
				style: { display: "flex", alignItems: "center", gap: 8 },
				children: [
					stepBtn("−", () => onChange(clampNum(min, max, Number(value) - step)), "调低"),
					react_jsx_runtime.jsx("input", {
						type: "range", min, max, step, value,
						onChange: (e) => onChange(Number(e.target.value)),
						style: { flex: 1, accentColor: "var(--dsw-accent, #4a7dff)" }
					}),
					stepBtn("+", () => onChange(clampNum(min, max, Number(value) + step)), "调高"),
					react_jsx_runtime.jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", minWidth: 46, textAlign: "right" }, children: display(value) })
				]
			}));
			return react_jsx_runtime.jsx("div", {
				style: { padding: "16px 20px", display: "grid", gap: 14, maxWidth: 520 },
				children: [
					react_jsx_runtime.jsx("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" }, children: "朗读设置" }),
					row("语音风格", react_jsx_runtime.jsx("select", {
						value: preset,
						onChange: (e) => onPreset(e.target.value),
						style: ctl,
						children: VOICE_PRESETS.map((p) => react_jsx_runtime.jsx("option", { value: p.id, children: p.label }, p.id))
					})),
					slider("语速", rate, 0.5, 2, 0.05, (v) => writeSetting("rate", v), (v) => Number(v).toFixed(2) + "×"),
					slider("音高", pitch, -10, 10, 1, (v) => writeSetting("pitch", v), (v) => (Number(v) > 0 ? "+" : "") + v),
					row("自动播放", react_jsx_runtime.jsx("input", {
						type: "checkbox", checked: !!autoPlay,
						onChange: (e) => writeSetting("autoPlay", e.target.checked)
					})),
					// REQ-009：过程播报开关（默认关，想听 Agent 干活过程再打开）
					// 依赖约束：processNarration ⟹ autoPlay，autoPlay 关时置灰不可点（值已被 mergeSettings 钳成 false）
					row("过程播报", react_jsx_runtime.jsx("input", {
						type: "checkbox", checked: !!processNarration,
						disabled: !autoPlay,
						title: autoPlay ? "" : "需先开启自动播放",
						onChange: (e) => writeSetting("processNarration", e.target.checked)
					})),
					react_jsx_runtime.jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", lineHeight: 1.6 }, children: "「语音风格」会同时设置语速与音高为该风格默认值，之后仍可单独微调。自动播放开启后，收到新的回复会自动朗读（点 ⏹ 可打断）。过程播报开启后，Agent 干活（生成回复、调用工具）期间会实时朗读它的叙述性步骤；只想听结果就保持关闭。过程播报依赖自动播放：需先开启自动播放才能使用，关闭自动播放会同时关闭过程播报（此时该开关置灰不可点）。设置即时生效并自动保存（浏览器本地存储）。" })
				]
			});
		}

		/** 客户端插件主体：动作条朗读按钮 + 设置页。 */
		function apply(ctx) {
			ttsCtx = ctx;
			// REQ-009：过程播报监控器 —— 模块级轮询，不挂任何组件（工具执行期可能一个助手行都没渲染）
			startProcessNarrationMonitor();
			// 设置页：挂到「设置 → 插件」分区
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "tts-reader",
				order: 60,
				label: "朗读"
			}, TtsSettingsTab));
			// 动作条朗读按钮
			ctx.slots.inject("conversation.chat.assistant-actions", () => {
				const dispose = ctx.slots.register({
					name: "conversation.chat.assistant-actions",
					id: "tts-reader",
					order: 15,
					inject: (sessionId) => ({ sessionId })
				}, TtsButton);
				return () => {
					dispose();
					stopSpeaking();
				};
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
