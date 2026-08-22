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
 * - 语音：8 个「性别 × 风格」预设（女声 4 + 男声 4），可微调语速/音高。
 * - 设置页：settings.plugins.tab 上的「朗读」Tab；设置经 localStorage 持久化
 *   （第三方插件位置无法 import 宿主 settings 依赖，故用浏览器本地存储），
 *   支持自动播放（新回复自动开读，sessionStorage 去重）。
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

		/** 朗读预设：性别 × 风格，共 8 项（每项 = 语音偏好 + 默认语速 + 默认音高）。 */
		const VOICE_PRESETS = [
			{ id: "female-calm",   label: "女声 · 平静", voice: ["晓伊", "xiaoyi"],   rate: 1.0, pitch: 0 },
			{ id: "female-gentle", label: "女声 · 温柔", voice: ["晓伊", "xiaoyi"],   rate: 0.9, pitch: 2 },
			{ id: "female-lively", label: "女声 · 活泼", voice: ["晓晓", "xiaoxiao"], rate: 1.2, pitch: 5 },
			{ id: "female-intel",  label: "女声 · 知性", voice: ["晓晓", "xiaoxiao"], rate: 1.0, pitch: 1 },
			{ id: "male-calm",     label: "男声 · 沉稳", voice: ["云希", "yunxi"],    rate: 0.8, pitch: -3 },
			{ id: "male-sunny",    label: "男声 · 阳光", voice: ["云希", "yunxi"],    rate: 1.1, pitch: 2 },
			{ id: "male-velvet",   label: "男声 · 磁性", voice: ["云扬", "yunyang"],  rate: 0.9, pitch: -2 },
			{ id: "male-crisp",    label: "男声 · 干练", voice: ["云扬", "yunyang"],  rate: 1.0, pitch: 0 }
		];
		/** 设置默认值。 */
		const DEFAULT_SETTINGS = { preset: "female-calm", rate: 1.0, pitch: 0, autoPlay: false };

		const normVoice = (s) => String(s).toLowerCase().replace(/\s+/g, "");
		const clampNum = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
		let zhVoice = null;
		/** 按预设挑语音：优先预设内候选名，找不到再兜底自然语音/任意中文语音。 */
		function pickPresetVoice(presetId) {
			const preset = VOICE_PRESETS.find((p) => p.id === presetId) || VOICE_PRESETS[0];
			if (!window.speechSynthesis) return;
			const voices = window.speechSynthesis.getVoices();
			if (!voices.length) return;
			const zh = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("zh"));
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
			u.lang = "zh-CN";
			if (zhVoice) u.voice = zhVoice;
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
					react_jsx_runtime.jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", lineHeight: 1.6 }, children: "「语音风格」会同时设置语速与音高为该风格默认值，之后仍可单独微调。自动播放开启后，收到新的回复会自动朗读（点 ⏹ 可打断）。设置即时生效并自动保存（浏览器本地存储）。" })
				]
			});
		}

		/** 客户端插件主体：动作条朗读按钮 + 设置页。 */
		function apply(ctx) {
			ttsCtx = ctx;
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
