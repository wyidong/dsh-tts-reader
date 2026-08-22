/**
 * dsh-tts-reader — 宿主侧（Node half）。
 * 纯 UI 插件：空 apply 使其出现在宿主 cordis.yml / Loader 中；
 * 浏览器侧通过 package.json 的 dsh.client 声明，经 exports["./client"] 交付。
 */
function apply() {}

export { apply };
