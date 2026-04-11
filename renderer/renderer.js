/* ========================================
   AI Proxy Bridge - 渲染进程脚本 v3
   圆润丝滑 / 模型Logo+能力 / 测试面板 / 实例关闭
   ======================================== */

// 模型元数据 — 用于已知的模型，未知模型使用 PROVIDER_RULES 模糊匹配
// 更新至 2026年4月，覆盖 lmarena.ai 常见模型
const MODEL_META = {
    // ===== OpenAI =====
    'chatgpt-4o-latest':  { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'gpt-4o':             { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'gpt-4o-mini':        { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'gpt-4.1':            { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'gpt-4.1-mini':       { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'gpt-4.1-nano':       { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'gpt-4.5':            { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'gpt-5':              { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'gpt-5.1':            { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'gpt-5.2':            { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'gpt-5.3':            { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'gpt-5.4':            { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'o1':                 { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'o3':                 { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'o3-mini':            { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'o4-mini':            { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },
    'dall-e-3':           { color:'#10a37f', bg:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', logoType:'openai', provider:'OpenAI' },

    // ===== Anthropic =====
    'claude-3.5-sonnet':  { color:'#d97706', bg:'linear-gradient(135deg,#fef3c7,#fde68a)', logoType:'anthropic', provider:'Anthropic' },
    'claude-3.7-sonnet':  { color:'#d97706', bg:'linear-gradient(135deg,#fef3c7,#fde68a)', logoType:'anthropic', provider:'Anthropic' },
    'claude-3-opus':      { color:'#d97706', bg:'linear-gradient(135deg,#fef3c7,#fde68a)', logoType:'anthropic', provider:'Anthropic' },
    'claude-3-haiku':     { color:'#d97706', bg:'linear-gradient(135deg,#fef3c7,#fde68a)', logoType:'anthropic', provider:'Anthropic' },
    'claude-sonnet-4':    { color:'#d97706', bg:'linear-gradient(135deg,#fef3c7,#fde68a)', logoType:'anthropic', provider:'Anthropic' },
    'claude-sonnet-4.5':  { color:'#d97706', bg:'linear-gradient(135deg,#fef3c7,#fde68a)', logoType:'anthropic', provider:'Anthropic' },
    'claude-sonnet-4.6':  { color:'#d97706', bg:'linear-gradient(135deg,#fef3c7,#fde68a)', logoType:'anthropic', provider:'Anthropic' },
    'claude-opus-4':      { color:'#d97706', bg:'linear-gradient(135deg,#fef3c7,#fde68a)', logoType:'anthropic', provider:'Anthropic' },
    'claude-opus-4.1':    { color:'#d97706', bg:'linear-gradient(135deg,#fef3c7,#fde68a)', logoType:'anthropic', provider:'Anthropic' },
    'claude-opus-4.5':    { color:'#d97706', bg:'linear-gradient(135deg,#fef3c7,#fde68a)', logoType:'anthropic', provider:'Anthropic' },
    'claude-opus-4.6':    { color:'#d97706', bg:'linear-gradient(135deg,#fef3c7,#fde68a)', logoType:'anthropic', provider:'Anthropic' },

    // ===== Google =====
    'gemini-2.0-flash':   { color:'#4285f4', bg:'linear-gradient(135deg,#e8f0fe,#d4e4fd)', logoType:'google', provider:'Google' },
    'gemini-2.5-pro':     { color:'#4285f4', bg:'linear-gradient(135deg,#e8f0fe,#d4e4fd)', logoType:'google', provider:'Google' },
    'gemini-2.5-flash':   { color:'#4285f4', bg:'linear-gradient(135deg,#e8f0fe,#d4e4fd)', logoType:'google', provider:'Google' },
    'gemini-3-pro':       { color:'#4285f4', bg:'linear-gradient(135deg,#e8f0fe,#d4e4fd)', logoType:'google', provider:'Google' },
    'gemini-3-flash':     { color:'#4285f4', bg:'linear-gradient(135deg,#e8f0fe,#d4e4fd)', logoType:'google', provider:'Google' },
    'gemini-3.1-pro':     { color:'#4285f4', bg:'linear-gradient(135deg,#e8f0fe,#d4e4fd)', logoType:'google', provider:'Google' },
    'gemma-3':            { color:'#4285f4', bg:'linear-gradient(135deg,#e8f0fe,#d4e4fd)', logoType:'google', provider:'Google' },

    // ===== Meta =====
    'llama-3.3-70b':      { color:'#6366f1', bg:'linear-gradient(135deg,#eef2ff,#e0e7ff)', logoType:'meta', provider:'Meta' },
    'llama-4-maverick':   { color:'#6366f1', bg:'linear-gradient(135deg,#eef2ff,#e0e7ff)', logoType:'meta', provider:'Meta' },
    'llama-4-scout':      { color:'#6366f1', bg:'linear-gradient(135deg,#eef2ff,#e0e7ff)', logoType:'meta', provider:'Meta' },

    // ===== DeepSeek =====
    'deepseek-v3':        { color:'#2563eb', bg:'linear-gradient(135deg,#dbeafe,#bfdbfe)', logoType:'deepseek', provider:'DeepSeek' },
    'deepseek-v3.1':      { color:'#2563eb', bg:'linear-gradient(135deg,#dbeafe,#bfdbfe)', logoType:'deepseek', provider:'DeepSeek' },
    'deepseek-v3.2':      { color:'#2563eb', bg:'linear-gradient(135deg,#dbeafe,#bfdbfe)', logoType:'deepseek', provider:'DeepSeek' },
    'deepseek-r1':        { color:'#2563eb', bg:'linear-gradient(135deg,#dbeafe,#bfdbfe)', logoType:'deepseek', provider:'DeepSeek' },
    'deepseek-r2':        { color:'#2563eb', bg:'linear-gradient(135deg,#dbeafe,#bfdbfe)', logoType:'deepseek', provider:'DeepSeek' },

    // ===== Alibaba/Qwen =====
    'qwen-plus':          { color:'#dc2626', bg:'linear-gradient(135deg,#fee2e2,#fecaca)', logoType:'alibaba', provider:'Alibaba' },
    'qwen-max':           { color:'#dc2626', bg:'linear-gradient(135deg,#fee2e2,#fecaca)', logoType:'alibaba', provider:'Alibaba' },
    'qwen2.5':            { color:'#dc2626', bg:'linear-gradient(135deg,#fee2e2,#fecaca)', logoType:'alibaba', provider:'Alibaba' },
    'qwen3':              { color:'#dc2626', bg:'linear-gradient(135deg,#fee2e2,#fecaca)', logoType:'alibaba', provider:'Alibaba' },
    'qwen3-235b':         { color:'#dc2626', bg:'linear-gradient(135deg,#fee2e2,#fecaca)', logoType:'alibaba', provider:'Alibaba' },

    // ===== Mistral =====
    'mistral-large':      { color:'#ff7000', bg:'linear-gradient(135deg,#fff7ed,#ffedd5)', logoType:'mistral', provider:'Mistral' },
    'mistral-medium':     { color:'#ff7000', bg:'linear-gradient(135deg,#fff7ed,#ffedd5)', logoType:'mistral', provider:'Mistral' },
    'mistral-small':      { color:'#ff7000', bg:'linear-gradient(135deg,#fff7ed,#ffedd5)', logoType:'mistral', provider:'Mistral' },
    'codestral':          { color:'#ff7000', bg:'linear-gradient(135deg,#fff7ed,#ffedd5)', logoType:'mistral', provider:'Mistral' },
    'mixtral':            { color:'#ff7000', bg:'linear-gradient(135deg,#fff7ed,#ffedd5)', logoType:'mistral', provider:'Mistral' },
    'pixtral':            { color:'#ff7000', bg:'linear-gradient(135deg,#fff7ed,#ffedd5)', logoType:'mistral', provider:'Mistral' },
    'ministral':          { color:'#ff7000', bg:'linear-gradient(135deg,#fff7ed,#ffedd5)', logoType:'mistral', provider:'Mistral' },

    // ===== xAI =====
    'grok-3':             { color:'#000000', bg:'linear-gradient(135deg,#f5f5f5,#e5e5e5)', logoType:'xai', provider:'xAI' },
    'grok-4':             { color:'#000000', bg:'linear-gradient(135deg,#f5f5f5,#e5e5e5)', logoType:'xai', provider:'xAI' },
    'grok-4.1':           { color:'#000000', bg:'linear-gradient(135deg,#f5f5f5,#e5e5e5)', logoType:'xai', provider:'xAI' },

    // ===== Zhipu =====
    'glm-4':              { color:'#3b82f6', bg:'linear-gradient(135deg,#dbeafe,#bfdbfe)', logoType:'', provider:'Zhipu' },
    'glm-4.5':            { color:'#3b82f6', bg:'linear-gradient(135deg,#dbeafe,#bfdbfe)', logoType:'', provider:'Zhipu' },
    'glm-4.7':            { color:'#3b82f6', bg:'linear-gradient(135deg,#dbeafe,#bfdbfe)', logoType:'', provider:'Zhipu' },
    'glm-5':              { color:'#3b82f6', bg:'linear-gradient(135deg,#dbeafe,#bfdbfe)', logoType:'', provider:'Zhipu' },
    'glm-5.1':            { color:'#3b82f6', bg:'linear-gradient(135deg,#dbeafe,#bfdbfe)', logoType:'', provider:'Zhipu' },

    // ===== Moonshot =====
    'kimi':               { color:'#7c3aed', bg:'linear-gradient(135deg,#ede9fe,#ddd6fe)', logoType:'', provider:'Moonshot' },
    'kimi-2':             { color:'#7c3aed', bg:'linear-gradient(135deg,#ede9fe,#ddd6fe)', logoType:'', provider:'Moonshot' },
    'kimi-2.5':           { color:'#7c3aed', bg:'linear-gradient(135deg,#ede9fe,#ddd6fe)', logoType:'', provider:'Moonshot' },

    // ===== Cohere =====
    'command-r':          { color:'#39594d', bg:'linear-gradient(135deg,#ecfdf5,#d1fae5)', logoType:'', provider:'Cohere' },
    'command-r-plus':     { color:'#39594d', bg:'linear-gradient(135deg,#ecfdf5,#d1fae5)', logoType:'', provider:'Cohere' },

    // ===== 01.AI =====
    'yi-lightning':       { color:'#2563eb', bg:'linear-gradient(135deg,#dbeafe,#bfdbfe)', logoType:'', provider:'01.AI' },
    'yi-large':           { color:'#2563eb', bg:'linear-gradient(135deg,#dbeafe,#bfdbfe)', logoType:'', provider:'01.AI' },

    // ===== Microsoft =====
    'phi-4':              { color:'#0078d4', bg:'linear-gradient(135deg,#e0f2fe,#bae6fd)', logoType:'', provider:'Microsoft' },

    // ===== MiniMax =====
    'minimax':            { color:'#0891b2', bg:'linear-gradient(135deg,#ecfeff,#cffafe)', logoType:'', provider:'MiniMax' },
    'mimo':               { color:'#0891b2', bg:'linear-gradient(135deg,#ecfeff,#cffafe)', logoType:'', provider:'MiniMax' },
};

// 根据 model ID 模糊匹配 provider 和 logoType
const PROVIDER_RULES = [
    { pattern: /^(gpt-|o[134]-?|dall-e|chatgpt-)/i, provider: 'OpenAI', logoType: 'openai', color: '#10a37f', bg: 'linear-gradient(135deg,#e8f5e9,#c8e6c9)' },
    { pattern: /^claude-/i, provider: 'Anthropic', logoType: 'anthropic', color: '#d97706', bg: 'linear-gradient(135deg,#fef3c7,#fde68a)' },
    { pattern: /^(gemini-|gemma-|imagen-)/i, provider: 'Google', logoType: 'google', color: '#4285f4', bg: 'linear-gradient(135deg,#e8f0fe,#d4e4fd)' },
    { pattern: /^(llama-|lama-)/i, provider: 'Meta', logoType: 'meta', color: '#6366f1', bg: 'linear-gradient(135deg,#eef2ff,#e0e7ff)' },
    { pattern: /^deepseek-/i, provider: 'DeepSeek', logoType: 'deepseek', color: '#2563eb', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /^qwen/i, provider: 'Alibaba', logoType: 'alibaba', color: '#dc2626', bg: 'linear-gradient(135deg,#fee2e2,#fecaca)' },
    { pattern: /^(mistral-|mixtral-|pixtral-|codestral-|mathstral-)/i, provider: 'Mistral', logoType: 'mistral', color: '#ff7000', bg: 'linear-gradient(135deg,#fff7ed,#ffedd5)' },
    { pattern: /^grok-/i, provider: 'xAI', logoType: 'xai', color: '#000', bg: 'linear-gradient(135deg,#f5f5f5,#e5e5e5)' },
    { pattern: /^(glm-|cogvlm-|cogvideox?)/i, provider: 'Zhipu', logoType: '', color: '#3b82f6', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /^(kimi-|moonshot-)/i, provider: 'Moonshot', logoType: '', color: '#7c3aed', bg: 'linear-gradient(135deg,#ede9fe,#ddd6fe)' },
    { pattern: /^(phi-|wizardlm-)/i, provider: 'Microsoft', logoType: '', color: '#0078d4', bg: 'linear-gradient(135deg,#e0f2fe,#bae6fd)' },
    { pattern: /^(minimax|mimo)/i, provider: 'MiniMax', logoType: '', color: '#0891b2', bg: 'linear-gradient(135deg,#ecfeff,#cffafe)' },
    { pattern: /^command-/i, provider: 'Cohere', logoType: '', color: '#39594d', bg: 'linear-gradient(135deg,#ecfdf5,#d1fae5)' },
    { pattern: /^dbrx/i, provider: 'Databricks', logoType: '', color: '#ff3621', bg: 'linear-gradient(135deg,#fff1f2,#fee2e2)' },
    { pattern: /^yi-/i, provider: '01.AI', logoType: '', color: '#2563eb', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /^(ernie-|wenxin)/i, provider: 'Baidu', logoType: '', color: '#2563eb', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /^(pplx-|sonar-)/i, provider: 'Perplexity', logoType: '', color: '#22c55e', bg: 'linear-gradient(135deg,#f0fdf4,#dcfce7)' },
    { pattern: /^(internlm|internvl)/i, provider: 'InternLM', logoType: '', color: '#7c3aed', bg: 'linear-gradient(135deg,#ede9fe,#ddd6fe)' },
    { pattern: /^(solar-|upstage-)/i, provider: 'Upstage', logoType: '', color: '#f59e0b', bg: 'linear-gradient(135deg,#fffbeb,#fef3c7)' },
    { pattern: /^(nous[-_]|hermes-)/i, provider: 'NousResearch', logoType: '', color: '#6366f1', bg: 'linear-gradient(135deg,#eef2ff,#e0e7ff)' },
    { pattern: /^(nvidia-|llama3-nvidia)/i, provider: 'NVIDIA', logoType: '', color: '#76b900', bg: 'linear-gradient(135deg,#f0fdf4,#dcfce7)' },
    { pattern: /^(inflection-|pi-)/i, provider: 'Inflection', logoType: '', color: '#2563eb', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /^(zero-?one-?ai|zeroone)/i, provider: '01.AI', logoType: '', color: '#2563eb', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /^(reka-)/i, provider: 'Reka', logoType: '', color: '#7c3aed', bg: 'linear-gradient(135deg,#ede9fe,#ddd6fe)' },
    { pattern: /^(snowflake-|arctic-)/i, provider: 'Snowflake', logoType: '', color: '#29b5e8', bg: 'linear-gradient(135deg,#ecfeff,#cffafe)' },
    { pattern: /^(dolphin-)/i, provider: 'Cognitive Computations', logoType: '', color: '#0891b2', bg: 'linear-gradient(135deg,#ecfeff,#cffafe)' },
    { pattern: /^(openchat-)/i, provider: 'OpenChat', logoType: '', color: '#10a37f', bg: 'linear-gradient(135deg,#e8f5e9,#c8e6c9)' },
    { pattern: /^(c4ai-|aya-)/i, provider: 'Cohere', logoType: '', color: '#39594d', bg: 'linear-gradient(135deg,#ecfdf5,#d1fae5)' },
    { pattern: /^(flux-|sdxl-|stable-)/i, provider: 'Stability AI', logoType: '', color: '#7c3aed', bg: 'linear-gradient(135deg,#ede9fe,#ddd6fe)' },
    { pattern: /^(ideogram-)/i, provider: 'Ideogram', logoType: '', color: '#ec4899', bg: 'linear-gradient(135deg,#fdf2f8,#fce7f3)' },
    { pattern: /^(playground-)/i, provider: 'Playground AI', logoType: '', color: '#f59e0b', bg: 'linear-gradient(135deg,#fffbeb,#fef3c7)' },
    { pattern: /^(seedream-)/i, provider: 'ByteDance', logoType: '', color: '#000', bg: 'linear-gradient(135deg,#f5f5f5,#e5e5e5)' },
    { pattern: /^(wan-)/i, provider: 'Alibaba', logoType: 'alibaba', color: '#dc2626', bg: 'linear-gradient(135deg,#fee2e2,#fecaca)' },
    { pattern: /^(hunyuan-)/i, provider: 'Tencent', logoType: '', color: '#2563eb', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /^(step-|stepfun-)/i, provider: 'StepFun', logoType: '', color: '#f59e0b', bg: 'linear-gradient(135deg,#fffbeb,#fef3c7)' },
    { pattern: /^(abab-)/i, provider: 'MiniMax', logoType: '', color: '#0891b2', bg: 'linear-gradient(135deg,#ecfeff,#cffafe)' },
    { pattern: /^(sensechat|sensenovel)/i, provider: 'SenseTime', logoType: '', color: '#6366f1', bg: 'linear-gradient(135deg,#eef2ff,#e0e7ff)' },
    { pattern: /^(mapneo-)/i, provider: 'MapNeo', logoType: '', color: '#0891b2', bg: 'linear-gradient(135deg,#ecfeff,#cffafe)' },
    { pattern: /^(lmsys-|vicuna-|fastchat-)/i, provider: 'LMSYS', logoType: '', color: '#10a37f', bg: 'linear-gradient(135deg,#e8f5e9,#c8e6c9)' },
    { pattern: /^(mpt-)/i, provider: 'MosaicML', logoType: '', color: '#6366f1', bg: 'linear-gradient(135deg,#eef2ff,#e0e7ff)' },
    { pattern: /^(falcon-)/i, provider: 'TII', logoType: '', color: '#2563eb', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /^(stabilityai-)/i, provider: 'Stability AI', logoType: '', color: '#7c3aed', bg: 'linear-gradient(135deg,#ede9fe,#ddd6fe)' },
    { pattern: /^(meta-llama-)/i, provider: 'Meta', logoType: 'meta', color: '#6366f1', bg: 'linear-gradient(135deg,#eef2ff,#e0e7ff)' },
    // 包含厂商名的 slug（如 openai/gpt-4o, anthropic/claude-3 等）
    { pattern: /\/(gpt-|o[134]|dall-e|chatgpt)/i, provider: 'OpenAI', logoType: 'openai', color: '#10a37f', bg: 'linear-gradient(135deg,#e8f5e9,#c8e6c9)' },
    { pattern: /\/claude-/i, provider: 'Anthropic', logoType: 'anthropic', color: '#d97706', bg: 'linear-gradient(135deg,#fef3c7,#fde68a)' },
    { pattern: /\/(gemini-|gemma-|imagen-)/i, provider: 'Google', logoType: 'google', color: '#4285f4', bg: 'linear-gradient(135deg,#e8f0fe,#d4e4fd)' },
    { pattern: /\/llama-/i, provider: 'Meta', logoType: 'meta', color: '#6366f1', bg: 'linear-gradient(135deg,#eef2ff,#e0e7ff)' },
    { pattern: /\/deepseek-/i, provider: 'DeepSeek', logoType: 'deepseek', color: '#2563eb', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /\/qwen/i, provider: 'Alibaba', logoType: 'alibaba', color: '#dc2626', bg: 'linear-gradient(135deg,#fee2e2,#fecaca)' },
    { pattern: /\/(mistral-|mixtral-|pixtral-)/i, provider: 'Mistral', logoType: 'mistral', color: '#ff7000', bg: 'linear-gradient(135deg,#fff7ed,#ffedd5)' },
    { pattern: /\/grok-/i, provider: 'xAI', logoType: 'xai', color: '#000', bg: 'linear-gradient(135deg,#f5f5f5,#e5e5e5)' },
    { pattern: /\/glm-/i, provider: 'Zhipu', logoType: '', color: '#3b82f6', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    // 关键词匹配：slug 中包含厂商名
    { pattern: /openai/i, provider: 'OpenAI', logoType: 'openai', color: '#10a37f', bg: 'linear-gradient(135deg,#e8f5e9,#c8e6c9)' },
    { pattern: /anthropic/i, provider: 'Anthropic', logoType: 'anthropic', color: '#d97706', bg: 'linear-gradient(135deg,#fef3c7,#fde68a)' },
    { pattern: /google/i, provider: 'Google', logoType: 'google', color: '#4285f4', bg: 'linear-gradient(135deg,#e8f0fe,#d4e4fd)' },
    { pattern: /deepseek/i, provider: 'DeepSeek', logoType: 'deepseek', color: '#2563eb', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /alibaba|qwen/i, provider: 'Alibaba', logoType: 'alibaba', color: '#dc2626', bg: 'linear-gradient(135deg,#fee2e2,#fecaca)' },
    { pattern: /mistral|mixtral|pixtral|codestral/i, provider: 'Mistral', logoType: 'mistral', color: '#ff7000', bg: 'linear-gradient(135deg,#fff7ed,#ffedd5)' },
    { pattern: /xai|grok/i, provider: 'xAI', logoType: 'xai', color: '#000', bg: 'linear-gradient(135deg,#f5f5f5,#e5e5e5)' },
    { pattern: /meta[-_]|llama/i, provider: 'Meta', logoType: 'meta', color: '#6366f1', bg: 'linear-gradient(135deg,#eef2ff,#e0e7ff)' },
    { pattern: /zhipu|glm-/i, provider: 'Zhipu', logoType: '', color: '#3b82f6', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /moonshot|kimi/i, provider: 'Moonshot', logoType: '', color: '#7c3aed', bg: 'linear-gradient(135deg,#ede9fe,#ddd6fe)' },
    { pattern: /microsoft|phi-/i, provider: 'Microsoft', logoType: '', color: '#0078d4', bg: 'linear-gradient(135deg,#e0f2fe,#bae6fd)' },
    { pattern: /minimax|mimo|abab/i, provider: 'MiniMax', logoType: '', color: '#0891b2', bg: 'linear-gradient(135deg,#ecfeff,#cffafe)' },
    { pattern: /cohere|command-|c4ai-|aya-/i, provider: 'Cohere', logoType: '', color: '#39594d', bg: 'linear-gradient(135deg,#ecfdf5,#d1fae5)' },
    { pattern: /dbrx|databricks/i, provider: 'Databricks', logoType: '', color: '#ff3621', bg: 'linear-gradient(135deg,#fff1f2,#fee2e2)' },
    { pattern: /01[-_]?ai|yi-/i, provider: '01.AI', logoType: '', color: '#2563eb', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /baidu|ernie|wenxin/i, provider: 'Baidu', logoType: '', color: '#2563eb', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /perplexity|pplx-|sonar-/i, provider: 'Perplexity', logoType: '', color: '#22c55e', bg: 'linear-gradient(135deg,#f0fdf4,#dcfce7)' },
    { pattern: /nvidia/i, provider: 'NVIDIA', logoType: '', color: '#76b900', bg: 'linear-gradient(135deg,#f0fdf4,#dcfce7)' },
    { pattern: /stability|flux-|sdxl-|stable-/i, provider: 'Stability AI', logoType: '', color: '#7c3aed', bg: 'linear-gradient(135deg,#ede9fe,#ddd6fe)' },
    { pattern: /bytedance|seedream/i, provider: 'ByteDance', logoType: '', color: '#000', bg: 'linear-gradient(135deg,#f5f5f5,#e5e5e5)' },
    { pattern: /tencent|hunyuan/i, provider: 'Tencent', logoType: '', color: '#2563eb', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /internlm|internvl/i, provider: 'InternLM', logoType: '', color: '#7c3aed', bg: 'linear-gradient(135deg,#ede9fe,#ddd6fe)' },
    { pattern: /upstage|solar-/i, provider: 'Upstage', logoType: '', color: '#f59e0b', bg: 'linear-gradient(135deg,#fffbeb,#fef3c7)' },
    { pattern: /nous|hermes/i, provider: 'NousResearch', logoType: '', color: '#6366f1', bg: 'linear-gradient(135deg,#eef2ff,#e0e7ff)' },
    { pattern: /snowflake|arctic/i, provider: 'Snowflake', logoType: '', color: '#29b5e8', bg: 'linear-gradient(135deg,#ecfeff,#cffafe)' },
    { pattern: /ideogram/i, provider: 'Ideogram', logoType: '', color: '#ec4899', bg: 'linear-gradient(135deg,#fdf2f8,#fce7f3)' },
    { pattern: /stepfun|step-/i, provider: 'StepFun', logoType: '', color: '#f59e0b', bg: 'linear-gradient(135deg,#fffbeb,#fef3c7)' },
    { pattern: /sensetime|sensechat/i, provider: 'SenseTime', logoType: '', color: '#6366f1', bg: 'linear-gradient(135deg,#eef2ff,#e0e7ff)' },
    { pattern: /inflection/i, provider: 'Inflection', logoType: '', color: '#2563eb', bg: 'linear-gradient(135deg,#dbeafe,#bfdbfe)' },
    { pattern: /reka/i, provider: 'Reka', logoType: '', color: '#7c3aed', bg: 'linear-gradient(135deg,#ede9fe,#ddd6fe)' },
];

function getModelMeta(modelId, modelName) {
    // 先精确匹配 MODEL_META
    if (MODEL_META[modelId]) return MODEL_META[modelId];
    // 用 name 也尝试匹配
    if (modelName && MODEL_META[modelName]) return MODEL_META[modelName];
    // 用 name 做 PROVIDER_RULES 模糊匹配（name 更可能是 slug 如 "gpt-4o"）
    var tryValues = [modelId];
    if (modelName) tryValues.push(modelName);
    for (var i = 0; i < tryValues.length; i++) {
        for (var j = 0; j < PROVIDER_RULES.length; j++) {
            if (PROVIDER_RULES[j].pattern.test(tryValues[i])) {
                return { color: PROVIDER_RULES[j].color, bg: PROVIDER_RULES[j].bg, logoType: PROVIDER_RULES[j].logoType, provider: PROVIDER_RULES[j].provider };
            }
        }
    }
    return {};
}

const DEFAULT_MODEL_CAPS = { thinking:false, web:false, image:false, research:false, text:true, video:false, audio:false };const LOGO_SVGS = {
    openai: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg>',
    anthropic: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"/></svg>',
    google: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="#4285F4" d="M23 12.245c0-.905-.075-1.565-.236-2.25h-10.54v4.083h6.186c-.124 1.014-.797 2.542-2.294 3.569l-.021.136 3.332 2.53.23.022C21.779 18.417 23 15.593 23 12.245z"/><path fill="#34A853" d="M12.225 23c3.03 0 5.574-.978 7.433-2.665l-3.542-2.688c-.948.648-2.22 1.1-3.891 1.1a6.745 6.745 0 01-6.386-4.572l-.132.011-3.465 2.628-.045.124C4.043 20.531 7.835 23 12.225 23z"/><path fill="#FBBC05" d="M5.84 14.175A6.65 6.65 0 015.463 12c0-.758.138-1.491.361-2.175l-.006-.147-3.508-2.67-.115.054A10.831 10.831 0 001 12c0 1.772.436 3.447 1.197 4.938l3.642-2.763z"/><path fill="#EA4335" d="M12.225 5.253c2.108 0 3.529.892 4.34 1.638l3.167-3.031C17.787 2.088 15.255 1 12.225 1 7.834 1 4.043 3.469 2.197 7.062l3.63 2.763a6.77 6.77 0 016.398-4.572z"/></svg>',
    meta: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6.897 4c1.915 0 3.516.932 5.43 3.376l.282-.373c.19-.246.383-.484.58-.71l.313-.35C14.588 4.788 15.792 4 17.225 4c1.273 0 2.469.557 3.491 1.516l.218.213c1.73 1.765 2.917 4.71 3.053 8.026l.011.392.002.25c0 1.501-.28 2.759-.818 3.7l-.14.23-.108.153c-.301.42-.664.758-1.086 1.009l-.265.142-.087.04a3.493 3.493 0 01-.302.118 4.117 4.117 0 01-1.33.208c-.524 0-.996-.067-1.438-.215-.614-.204-1.163-.56-1.726-1.116l-.227-.235c-.753-.812-1.534-1.976-2.493-3.586l-1.43-2.41-.544-.895-1.766 3.13-.343.592C7.597 19.156 6.227 20 4.356 20c-1.21 0-2.205-.42-2.936-1.182l-.168-.184c-.484-.573-.837-1.311-1.043-2.189l-.067-.32a8.69 8.69 0 01-.136-1.288L0 14.468c.002-.745.06-1.49.174-2.23l.1-.573c.298-1.53.828-2.958 1.536-4.157l.209-.34c1.177-1.83 2.789-3.053 4.615-3.16L6.897 4zm-.033 2.615l-.201.01c-.83.083-1.606.673-2.252 1.577l-.138.199-.01.018c-.67 1.017-1.185 2.378-1.456 3.845l-.004.022a12.591 12.591 0 00-.207 2.254l.002.188c.004.18.017.36.04.54l.043.291c.092.503.257.908.486 1.208l.117.137c.303.323.698.492 1.17.492 1.1 0 1.796-.676 3.696-3.641l2.175-3.4.454-.701-.139-.198C9.11 7.3 8.084 6.616 6.864 6.616zm10.196-.552l-.176.007c-.635.048-1.223.359-1.82.933l-.196.198c-.439.462-.887 1.064-1.367 1.807l.266.398c.18.274.362.56.55.858l.293.475 1.396 2.335.695 1.114c.583.926 1.03 1.6 1.408 2.082l.213.262c.282.326.529.54.777.673l.102.05c.227.1.457.138.718.138.176.002.35-.023.518-.073.338-.104.61-.32.813-.637l.095-.163.077-.162c.194-.459.29-1.06.29-1.785l-.006-.449c-.08-2.871-.938-5.372-2.2-6.798l-.176-.189c-.67-.683-1.444-1.074-2.27-1.074z"/></svg>',
    deepseek: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"/></svg>',
    alibaba: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z"/></svg>'
};


// ===== DOM 引用 =====
var tabs = document.querySelectorAll('.tab-btn');
var tabContents = document.querySelectorAll('.tab-content');
var startBtn = document.getElementById('start-service');
var stopBtn = document.getElementById('stop-service');
var refreshModelsBtn = document.getElementById('refresh-models');
var createBrowserBtn = document.getElementById('create-browser');
var clearLogsBtn = document.getElementById('clear-logs');
var configForm = document.getElementById('config-form');
var logContainer = document.getElementById('log-container');

var themeToggle = document.getElementById('theme-toggle');
var iconSun = themeToggle.querySelector('.icon-sun');
var iconMoon = themeToggle.querySelector('.icon-moon');

var helpBtn = document.getElementById('help-btn');
var helpPanel = document.getElementById('help-panel');
var closeHelpBtn = document.getElementById('close-help');
var tooltipEl = document.getElementById('tooltip');

var winMinimize = document.getElementById('win-minimize');
var winMaximize = document.getElementById('win-maximize');
var winClose = document.getElementById('win-close');

var toggleKeyVis = document.getElementById('toggle-key-visibility');
var apiKeyInput = document.getElementById('api-key-input');

// 测试面板 DOM
var testPanel = document.getElementById('test-panel');
var testModelName = document.getElementById('test-model-name');
var testInput = document.getElementById('test-input');
var testSendBtn = document.getElementById('test-send-btn');
var testResult = document.getElementById('test-result');
var testPanelClose = document.getElementById('test-panel-close');

var isServiceRunning = false;
var config = {};

// ========== 窗口控制按钮 ==========
if (winMinimize) winMinimize.addEventListener('click', function () { window.api.minimizeWindow(); });
if (winMaximize) winMaximize.addEventListener('click', function () { window.api.maximizeWindow(); });
if (winClose) winClose.addEventListener('click', function () { window.api.closeWindow(); });

// 窗口最大化状态图标切换
window.api.onWindowStateChange(function (state) {
    var svg = winMaximize.querySelector('svg');
    if (state && state.maximized) {
        svg.innerHTML = '<path d="M7 15h10v-4a1 1 0 00-1-1H8a1 1 0 00-1 1v4zM7 9V5.5A1.5 1.5 0 018.5 4H11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 9V5.5A1.5 1.5 0 0015.5 4H13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
    } else {
        svg.innerHTML = '<rect x="2" y="2" width="10" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>';
    }
});

// ========== 主题系统 ==========
(function () {
    var saved = localStorage.getItem('apb-theme') || 'light';
    setTheme(saved);
})();

function setTheme(t) {
    var body = document.body;
    if (t === 'dark') {
        body.classList.remove('theme-light'); body.classList.add('theme-dark');
        iconSun.classList.add('hidden'); iconMoon.classList.remove('hidden');
    } else {
        body.classList.remove('theme-dark'); body.classList.add('theme-light');
        iconSun.classList.remove('hidden'); iconMoon.classList.add('hidden');
    }
    localStorage.setItem('apb-theme', t);
}
if (themeToggle) themeToggle.addEventListener('click', function () {
    var cur = document.body.classList.contains('theme-dark') ? 'dark' : 'light';
    setTheme(cur === 'dark' ? 'light' : 'dark');
});

// ========== 帮助面板 ==========
function openHelp() { helpPanel.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
function closeHelp() { helpPanel.classList.add('hidden'); document.body.style.overflow = ''; }
if (helpBtn) helpBtn.addEventListener('click', openHelp);
if (closeHelpBtn) closeHelpBtn.addEventListener('click', closeHelp);
if (helpPanel) helpPanel.addEventListener('click', function (e) { if (e.target === helpPanel) closeHelp(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !helpPanel.classList.contains('hidden')) closeHelp(); });
// 主进程触发
window.api.onOpenHelp(openHelp);
window.api.onNavigateTab(function (tabId) {
    switchTab(tabId);
});

function switchTab(tabId) {
    var btn = document.querySelector('[data-tab="' + tabId + '"]');
    if (btn) btn.click();
}

// ========== Tooltip 系统 ==========
var tooltipTimer = null;
document.querySelectorAll('.tooltip-trigger').forEach(function (el) {
    el.addEventListener('mouseenter', function (e) {
        var text = el.getAttribute('data-tooltip');
        if (!text) return;
        clearTimeout(tooltipTimer);
        tooltipTimer = setTimeout(function () {
            tooltipEl.textContent = text;
            var rect = el.getBoundingClientRect();
            var top = rect.bottom + 7;
            var left = rect.left + rect.width / 2;
            tooltipEl.style.left = '';
            tooltipEl.style.top = top + 'px';
            tooltipEl.classList.add('show');
            var tw = tooltipEl.offsetWidth;
            var finalLeft = left - tw / 2;
            if (finalLeft < 8) finalLeft = 8;
            if (finalLeft + tw > window.innerWidth - 8) finalLeft = window.innerWidth - 8 - tw;
            tooltipEl.style.left = finalLeft + 'px';
        }, 350);
    });
    el.addEventListener('mouseleave', function () {
        clearTimeout(tooltipTimer);
        tooltipEl.classList.remove('show');
    });
});

// ========== 标签页切换 ==========
tabs.forEach(function (btn) {
    btn.addEventListener('click', function () {
        var tabId = this.getAttribute('data-tab');
        tabs.forEach(function (b) { b.classList.remove('active'); });
        this.classList.add('active');
        tabContents.forEach(function (c) { c.classList.remove('active'); });
        var target = document.getElementById(tabId + '-tab');
        if (target) target.classList.add('active');
        if (tabId === 'models') loadModels();
        else if (tabId === 'browsers') loadBrowsers();
    });
});

// ========== 日志 ==========
function addLog(msg, type) {
    type = type || 'info';
    var entry = document.createElement('div');
    entry.className = 'log-entry ' + type;
    var ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    entry.textContent = '[' + ts + '] ' + msg;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
    while (logContainer.children.length > 500) { logContainer.removeChild(logContainer.firstChild); }
}
if (clearLogsBtn) clearLogsBtn.addEventListener('click', function () {
    logContainer.innerHTML = '<div class="log-entry info">[系统] 日志已清空</div>';
});

// ========== 密钥显示/隐藏 ==========
if (toggleKeyVis && apiKeyInput) {
    toggleKeyVis.addEventListener('click', function () {
        var isPassword = apiKeyInput.type === 'password';
        apiKeyInput.type = isPassword ? 'text' : 'password';
        this.querySelector('svg').innerHTML = isPassword
            ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1 -2.16 3.19m-6.72-1.07a3 3 0 1 1 -4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23" stroke-linecap="round"/>'
            : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>';
    });
    if (apiKeyInput.value) apiKeyInput.type = 'password';
}

// ========== 配置管理 ==========
async function loadConfig() {
    try {
        config = await window.api.getConfig();
        var hp = document.getElementById('http-port'), ak = document.getElementById('api-key-input');
        if (hp) hp.value = config.httpPort || 61001;
        if (ak) ak.value = config.apiKey || '';

        var apiUrlEl = document.getElementById('api-url');
        var apiKeyEl = document.getElementById('api-key');
        if (apiUrlEl) apiUrlEl.textContent = 'http://127.0.0.1:' + (config.httpPort || 61001);
        if (apiKeyEl) apiKeyEl.textContent = config.apiKey || '未设置';

        if (apiKeyInput && apiKeyInput.value) apiKeyInput.type = 'password';
    } catch (err) { addLog('加载配置失败: ' + err.message, 'error'); }
}
if (configForm) configForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var nc = {
        httpPort: parseInt(document.getElementById('http-port').value, 10),
        apiKey: document.getElementById('api-key-input').value.trim()
    };
    try {
        await window.api.updateConfig(nc);
        addLog('配置已保存，服务将自动重启以应用新配置', 'info');
        await loadConfig();
    } catch (err) { addLog('保存失败: ' + err.message, 'error'); }
});

// ========== 复制功能 ==========
document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
        var tid = this.getAttribute('data-copy');
        var el = document.getElementById(tid);
        var text = el ? el.textContent : '';
        navigator.clipboard.writeText(text).then(function () {
            var orig = this.textContent;
            this.textContent = '✓';
            this.style.color = 'var(--success)';
            this.style.borderColor = 'var(--success)';
            addLog('已复制: ' + text, 'info');
            var self = this;
            setTimeout(function () {
                self.textContent = orig;
                self.style.color = '';
                self.style.borderColor = '';
            }, 1200);
        }.bind(this), function () { addLog('复制失败，请手动复制', 'warning'); });
    });
});

// ========== 服务控制 — 带状态联动 ==========
if (startBtn) startBtn.addEventListener('click', async function () {
    try {
        addLog('正在启动代理服务...', 'info');
        this.disabled = true; this.innerHTML = '<svg class="spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/></svg> 启动中...';
        await window.api.startServices();
        addLog('服务启动成功', 'info');
    } catch (err) { addLog('启动失败: ' + err.message, 'error'); }
    finally {
        // 不恢复按钮状态——由 onServiceStatus 回调统一管理禁用/启用
    }
});
if (stopBtn) stopBtn.addEventListener('click', async function () {
    try {
        addLog('正在停止服务...', 'info');
        this.disabled = true; this.innerHTML = '停止中...';
        await window.api.stopServices();
        addLog('服务已停止', 'info');
    } catch (err) { addLog('停止失败: ' + err.message, 'error'); }
    finally {
        // 不恢复——由回调统一管理
    }
});
// 刷新模型列表按钮绑定
if (refreshModelsBtn) refreshModelsBtn.addEventListener('click', function () { refreshModels(); });

// ========== 模型列表 v3 — Logo + 能力标签 + 测试按钮 ==========
async function loadModels() {
    var list = document.getElementById('models-list');
    if (!list) return;
    list.innerHTML = '<div class="loading">正在获取模型列表...</div>';
    try {
        var models = await window.api.getModels();
        if (!models || models.length === 0) {
            list.innerHTML = '<div class="empty-state"><p>暂无可用模型</p><p style="margin-top:4px;font-size:12px">请先启动服务并创建浏览器实例</p></div>';
            return;
        }
        renderModelList(models);
    } catch (err) {
        list.innerHTML = '<div class="empty-state"><p>获取失败: ' + esc(err.message) + '</p></div>';
        addLog('加载模型失败: ' + err.message, 'error');
    }
}

// 刷新模型列表：主动触发服务端重新提取
async function refreshModels() {
    var btn = document.getElementById('refresh-models');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<svg class="spin" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/></svg> 刷新中...';
    }

    var list = document.getElementById('models-list');
    if (list) list.innerHTML = '<div class="loading">正在刷新模型列表...</div>';

    // 不再强制要求 isServiceRunning —— 服务会在 app ready 时自动启动
    // 即使状态回调延迟，IPC 端也能正确处理（browserManager 在 startServices 时已创建）
    console.log('[Renderer] refreshModels() → calling IPC, isServiceRunning=', isServiceRunning);

    try {
        var models = await window.api.refreshModels();
        console.log('[Renderer] refreshModels ← received:', models ? models.length : 'null/undefined', 'models');

        if (!models || models.length === 0) {
            if (list) list.innerHTML = '<div class="empty-state"><p>暂无可用模型</p><p style="margin-top:4px;font-size:12px;color:var(--text-tertiary)">可能需要先创建浏览器实例并登录 arena.ai</p></div>';
            addLog('刷新完成，未找到模型', 'warning');
        } else {
            renderModelList(models);
            addLog('模型列表已刷新，共 ' + models.length + ' 个模型', 'success');
        }
    } catch (err) {
        console.error('[Renderer] refreshModels error:', err);
        var errMsg = err && err.message ? err.message : String(err);
        if (list) list.innerHTML = '<div class="empty-state"><p>刷新失败</p><p style="margin-top:4px;font-size:12px;color:var(--error)">' + esc(errMsg) + '</p></div>';
        addLog('刷新模型失败: ' + errMsg, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6"/><path d="M2.5 12a10 10 0 0 1 16.5-6.3L21.5 8M21.5 12a10 10 0 0 1-16.5 6.3L2.5 16"/></svg> 刷新列表';
        }
    }
}

function renderModelList(models) {
    var list = document.getElementById('models-list');
    if (!list) return;

    // 按厂商分组
    var groups = {};
    models.forEach(function (m) {
        var meta = getModelMeta(m.id, m.slug || m.name);
        var provider = meta.provider || m.provider || '其他';
        if (!groups[provider]) groups[provider] = { meta: meta, models: [] };
        groups[provider].models.push(m);
    });

    // 排序：主要厂商优先
    var providerOrder = ['OpenAI', 'Anthropic', 'Google', 'Meta', 'DeepSeek', 'Alibaba', 'Mistral', 'xAI', 'Microsoft', 'Zhipu', 'Moonshot', 'Cohere', 'MiniMax', '01.AI', 'Databricks', 'Baidu', 'Perplexity', 'NVIDIA', 'Stability AI', 'ByteDance', 'Tencent', 'InternLM', 'Upstage', 'NousResearch', 'Snowflake', 'Ideogram', 'StepFun', 'SenseTime', 'LMSYS', 'Inflection', 'Reka', 'Cognitive Computations', 'OpenChat', 'Playground AI', 'MosaicML', 'TII', 'MapNeo', '其他'];
    var sortedGroups = Object.keys(groups).sort(function (a, b) {
        var ia = providerOrder.indexOf(a), ib = providerOrder.indexOf(b);
        if (ia === -1) ia = 999; if (ib === -1) ib = 999;
        return ia - ib;
    });

    var html = '';
    sortedGroups.forEach(function (provider) {
        var group = groups[provider];
        var meta = group.meta;
        var color = meta.color || '#888';
        var bg = meta.bg || '#eee';
        var logoType = meta.logoType || '';

        var logoHtml;
        if (logoType && LOGO_SVGS[logoType]) {
            logoHtml = '<span class="model-logo-svg" style="color:' + esc(color) + '">' + LOGO_SVGS[logoType] + '</span>';
        } else {
            logoHtml = '<span style="font-weight:700;font-size:15px;">' + esc(provider.charAt(0)) + '</span>';
        }

        html += '<div class="model-group" data-provider="' + esc(provider) + '">';
        html += '<div class="model-group-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">';
        html += '<div class="model-logo model-group-logo" style="background:' + esc(bg) + ';color:' + esc(color) + ';width:28px;height:28px;min-width:28px;font-size:12px">' + logoHtml + '</div>';
        html += '<span class="model-group-name">' + esc(provider) + '</span>';
        html += '<span class="model-group-count">' + group.models.length + '</span>';
        html += '<span class="model-group-toggle">▼</span>';
        html += '</div>';

        html += '<div class="model-group-items">';
        group.models.forEach(function (m) {
            var displayName = m.name || m.id;
            var copyId = m.slug || m.id;
            // 能力标签
            var slug = (m.slug || m.id || '').toLowerCase();
            var tags = getModelTags(slug);
            var tagsHtml = '';
            if (tags.length > 0) {
                tagsHtml = '<span class="model-chip-tags">' + tags.map(function(t) {
                    return '<span class="model-tag tag-' + t.type + '">' + t.label + '</span>';
                }).join('') + '</span>';
            }
            html += '<div class="model-chip" data-test-model="' + esc(m.id) + '" data-test-name="' + esc(displayName) + '" title="点击测试 ' + esc(displayName) + '">';
            html += '<span class="model-chip-name">' + esc(displayName) + '</span>';
            html += tagsHtml;
            html += '<button class="model-chip-copy" data-model-id="' + esc(copyId) + '" title="复制 ID" onclick="event.stopPropagation()">';
            html += '<svg viewBox="0 0 14 14" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="7" height="7" rx="1"/><path d="M10 4V3a1 1 0 00-1-1H3a1 1 0 00-1 1v6a1 1 0 001 1h1"/></svg>';
            html += '</button>';
            html += '</div>';
        });
        html += '</div>';
        html += '</div>';
    });

    list.innerHTML = html;

    // 复制按钮事件
    list.querySelectorAll('[data-model-id]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var mid = this.getAttribute('data-model-id');
            navigator.clipboard.writeText(mid).then(function () {
                this.textContent = '✓';
                this.style.color = 'var(--success)';
                addLog('已复制: ' + mid, 'info');
                var self = this;
                setTimeout(function () { self.innerHTML = '<svg viewBox="0 0 14 14" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="7" height="7" rx="1"/><path d="M10 4V3a1 1 0 00-1-1H3a1 1 0 00-1 1v6a1 1 0 001 1h1"/></svg>'; self.style.color = ''; }, 1200);
            }.bind(this));
        });
    });

    // 测试按钮事件（点击模型 chip）
    list.querySelectorAll('[data-test-model]').forEach(function (el) {
        el.addEventListener('click', function () {
            var model = this.getAttribute('data-test-model');
            var name = this.getAttribute('data-test-name');
            openTestPanel(model, name);
        });
    });
}

// 模型能力标签推断
function getModelTags(slug) {
    var tags = [];
    if (!slug) return tags;
    // 生图
    if (/(?:dall-e|ideogram|flux|sdxl|stable-diffusion|imagen|seedream|playground|midjourney)/.test(slug)) {
        tags.push({ type: 'image', label: '生图' });
    }
    // 视觉/图像理解
    if (/(?:vision|pixtral|gemma-3)/.test(slug) || /-(?:vision|vl)$/.test(slug)) {
        tags.push({ type: 'vision', label: '视觉' });
    }
    // 视频
    if (/(?:veo|video|kling|sora|cogvideo|wan)/.test(slug)) {
        tags.push({ type: 'video', label: '视频' });
    }
    // 音频/语音
    if (/(?:tts|audio|speech|whisper|gpt-4o-audio)/.test(slug)) {
        tags.push({ type: 'audio', label: '音频' });
    }
    // 搜索/联网
    if (/(?:search|grounding|perplexity|with-search)/.test(slug)) {
        tags.push({ type: 'search', label: '搜索' });
    }
    // 思考/推理
    if (/(?:thinking|reasoning|-r[12]$|-o[134]$)/.test(slug)) {
        tags.push({ type: 'thinking', label: '推理' });
    }
    // 代码
    if (/(?:codestral|codex|code|qwen.*coder|deepseek-coder)/.test(slug)) {
        tags.push({ type: 'code', label: '代码' });
    }
    // 如果没有任何标签，标记为文本
    if (tags.length === 0) {
        tags.push({ type: 'text', label: '文本' });
    }
    return tags;
}

// ========== 模型测试功能 ==========
function openTestPanel(model, name) {
    testPanel.classList.remove('hidden');
    testModelName.textContent = name + ' (' + model + ')';
    testModelName.dataset.model = model;
    testInput.value = '';
    testResult.className = 'test-result loading';
    testResult.textContent = '等待发送...';
    testSendBtn.disabled = false;
    testSendBtn.textContent = '发送';

    // 自动滚动到测试面板
    testPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // 聚焦输入框
    setTimeout(function () { testInput.focus(); }, 100);

    addLog('打开测试面板: ' + name, 'info');
}

if (testPanelClose) testPanelClose.addEventListener('click', function () {
    testPanel.classList.add('hidden');
});

if (testSendBtn) testSendBtn.addEventListener('click', runTest);

// Enter 发送（Shift+Enter 换行）
if (testInput) testInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runTest();
    }
});

async function runTest() {
    var model = testModelName.dataset.model;
    var message = testInput.value.trim();

    if (!message) {
        testInput.focus();
        return;
    }

    // UI 状态
    testSendBtn.disabled = true;
    testSendBtn.innerHTML = '<svg class="spin" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/></svg> 测试中';
    testResult.className = 'test-result loading';
    testResult.textContent = '\u27A1 \u6B63\u5728\u5411 ' + model + ' \u53D1\u9001\u8BF7\u6C42...\\n\\n(\u9700\u8981\u5148\u521B\u5EFA\u5E76\u767B\u554D\u6D4F\u89C8\u5668\u5B9E\u4F8B)';

    console.log('[Renderer] runTest() → model:', model, 'message:', message);

    try {
        var result = await window.api.testModel(model, message);
        console.log('[Renderer] runTest ← success, content length:', (result.content || '').length);
        testResult.className = 'test-result';
        testResult.textContent = result.content || '(\u7A7A\u54CD\u5E94)';
        addLog('\u6A21\u578B\u6D4B\u8BD5\u6210\u529F: ' + result.model, 'info');
    } catch (err) {
        console.error('[Renderer] runTest error:', err);
        testResult.className = 'test-result error';
        testResult.textContent = '\u274C \u6D4B\u8BD5\u5931\u8D25\n\n' + (err && err.message ? err.message : String(err));
        addLog('\u6A21\u578B\u6D4B\u8BD5\u5931\u8D25: ' + err.message, 'error');
    } finally {
        testSendBtn.disabled = false;
        testSendBtn.textContent = '\u53D1\u9001';
    }
}

// ========== 浏览器实例列表 v4 — 事件委托 + 彻底修复关闭按钮 ==========
function renderBrowserList(instances) {
    var list = document.getElementById('browsers-list');
    if (!list) return;

    if (!instances || instances.length === 0) {
        list.innerHTML = '<div class="empty-state">' +
            '<svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" opacity=".35"><rect x="6" y="10" width="36" height="26" rx="4"/><line x1="18" y1="36" x2="30" y2="36"/><line x1="24" y1="30" x2="24" y2="36"/></svg>' +
            '<p>暂无实例，点击右上角「新建实例」创建</p></div>';
        list.removeAttribute('data-delegated');
        return;
    }

    // 安全处理每个实例的 ID（确保是有限数字）
    list.innerHTML = instances.map(function (inst, idx) {
        var iid = inst.id;
        var numId = typeof iid === 'number' && isFinite(iid) ? iid : parseInt(iid, 10);
        if (!isFinite(numId)) numId = idx + 1;

        var statusClass = inst.status === 'active' ? 'active' : 'inactive';
        var statusText = inst.status === 'active' ? '运行中' : '已停止';
        var timeStr = inst.createdAt
            ? new Date(inst.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
            : '—';
        var urlStr = (inst.url || 'arena.ai').replace(/^https?:\/\//, '').split('/')[0];

        // 根据浏览器类型选择配色方案
        var isEdge = inst.browserType === 'edge' || (inst.browserPath && inst.browserPath.toLowerCase().includes('edge'));
        var iconColor = isEdge ? '#0078D4' : '#4285F4';

        return '<div class="browser-item" data-instance-id="' + numId + '">' +
            '<div class="browser-item-left">' +
                '<div class="browser-icon-wrap ' + statusClass + '">' +
                    '<svg viewBox="0 0 32 32" width="28" height="28">' +
                        '<rect x="2" y="5" width="28" height="20" rx="4" ry="4" fill="none" stroke="' + iconColor + '" stroke-width="1.8"/>' +
                        '<line x1="10" y1="25" x2="22" y2="25" stroke="' + iconColor + '" stroke-width="1.6" stroke-linecap="round"/>' +
                        '<line x1="16" y1="25" x2="16" y2="29" stroke="' + iconColor + '" stroke-width="1.6" stroke-linecap="round"/>' +
                        '<circle cx="16" cy="14" r="4" fill="' + iconColor + '" opacity="0.15"/>' +
                        '<circle cx="16" cy="14" r="2" fill="' + iconColor + '" opacity="0.4"/>' +
                        '<rect x="6" y="8" width="20" height="2" rx="1" fill="' + iconColor + '" opacity="0.25"/>' +
                    '</svg>' +
                '</div>' +
                '<div class="browser-info">' +
                    '<div class="browser-name">实例 #' + numId + (isEdge ? ' <small style="color:var(--text-tertiary);font-weight:400">Edge</small>' : '') + '</div>' +
                    '<div class="browser-meta">' +
                        '<span class="browser-url">' + esc(urlStr) + '</span>' +
                        '<span class="browser-sep">·</span>' +
                        '<span class="browser-time">' + timeStr + '</span>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="browser-item-right">' +
                '<span class="browser-status ' + statusClass + '">' +
                    '<span class="status-dot-inline" style="background:' + (inst.status === 'active' ? 'var(--success)' : 'var(--text-tertiary)') + ';box-shadow:0 0 4px ' + (inst.status === 'active' ? 'var(--success)44' : 'transparent') + '"></span>' +
                    statusText +
                '</span>' +
                '<button class="close-instance-btn" data-close-id="' + numId + '" title="关闭此实例">' +
                    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>' +
                '</button>' +
            '</div>' +
        '</div>';
    }).join('');

    // ===== 事件委托：只绑定一次，innerHTML 重建后不受影响 =====
    if (!list.getAttribute('data-delegated')) {
        list.setAttribute('data-delegated', 'true');
        list.addEventListener('click', function _closeDelegate(e) {
            var closeBtn = e.target.closest('.close-instance-btn');
            if (!closeBtn) return;

            e.stopPropagation();
            e.preventDefault();

            var rawId = closeBtn.getAttribute('data-close-id');
            console.log('[Renderer] Close btn clicked, raw ID:', rawId, 'type:', typeof rawId);

            var instanceId = parseInt(rawId, 10);
            if (!isFinite(instanceId)) {
                console.error('[Renderer] Invalid instance ID:', rawId);
                addLog('关闭失败：无效的实例 ID (' + rawId + ')', 'error');
                return;
            }
            closeInstance(instanceId);
        });
        console.log('[Renderer] ✓ Close button event delegate attached');
    }
}

// 缓存最新的实例列表
var _cachedBrowserList = null;

async function loadBrowsers() {
    var list = document.getElementById('browsers-list');
    if (!list) return;

    if (_cachedBrowserList && _cachedBrowserList.length > 0) {
        renderBrowserList(_cachedBrowserList);
        return;
    }

    list.innerHTML = '<div class="empty-state"><p>请使用「新建实例」按钮创建浏览器窗口</p></div>';
}

// 监听主进程推送的浏览器列表更新
window.api.onBrowserListUpdate(function (list) {
    _cachedBrowserList = list;
    renderBrowserList(list);
});

// 定期轮询检查实例状态（检测用户手动关闭的浏览器）
setInterval(async function () {
    if (_cachedBrowserList && _cachedBrowserList.length > 0 && isServiceRunning) {
        try {
            var currentList = await window.api.getInstances();
            // 如果数量变了说明有变化，更新显示
            if (currentList && currentList.length !== _cachedBrowserList.length) {
                _cachedBrowserList = currentList;
                renderBrowserList(currentList);
            }
        } catch (e) {}
    }
}, 5000);

// 关闭实例
async function closeInstance(instanceId) {
    var item = document.querySelector('[data-instance-id="' + instanceId + '"]');
    if (item) {
        item.style.opacity = '.4';
        item.style.pointerEvents = 'none';
    }

    try {
        var result = await window.api.closeBrowserInstance(instanceId);
        addLog('实例 #' + instanceId + ' 已关闭，剩余 ' + (result.remaining || 0) + ' 个', 'info');
    } catch (err) {
        addLog('关闭实例失败: ' + err.message, 'error');
        if (item) {
            item.style.opacity = '';
            item.style.pointerEvents = '';
        }
    }
}

// 新建实例
if (createBrowserBtn) createBrowserBtn.addEventListener('click', async function () {
    try {
        addLog('正在创建浏览器实例...', 'info');
        this.disabled = true;
        this.innerHTML = '创建中...';
        await window.api.createBrowserInstance();
        addLog('浏览器实例创建成功，请在新窗口完成登录验证', 'info');
    } catch (err) {
        addLog('创建失败: ' + err.message, 'error');
    } finally {
        this.disabled = false;
        this.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> 新建实例';
    }
});

// ========== WebSocket 客户端管理 ==========
var _cachedWsClients = null;

function renderWsClientList(clients) {
    var list = document.getElementById('ws-clients-list');
    if (!list) return;

    // 更新状态徽章
    var badge = document.getElementById('ws-status-badge');
    if (badge) {
        var dot = badge.querySelector('.status-dot');
        var txt = badge.querySelector('.status-text');
        if (clients && clients.length > 0) {
            dot.className = 'status-dot online';
            txt.textContent = clients.length + ' 个已连接';
        } else {
            dot.className = 'status-dot offline';
            txt.textContent = '未连接';
        }
    }

    if (!clients || clients.length === 0) {
        list.innerHTML = '<div class="empty-state">' +
            '<svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" opacity=".35"><circle cx="24" cy="24" r="20"/><path d="M16 24h16M24 16v16"/></svg>' +
            '<p>暂无 WebSocket 客户端连接</p></div>';
        return;
    }

    list.innerHTML = clients.map(function (c) {
        var statusClass = c.status === 'connected' ? 'active' : 'inactive';
        var statusText = c.status === 'connected' ? '已连接' : '已断开';
        var timeStr = c.connectedAt
            ? new Date(c.connectedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
            : '—';
        var ipStr = (c.ip || '').replace('::ffff:', '');

        return '<div class="browser-item">' +
            '<div class="browser-item-left">' +
                '<div class="browser-icon-wrap ' + statusClass + '">' +
                    '<svg viewBox="0 0 32 32" width="28" height="28">' +
                        '<circle cx="16" cy="16" r="12" fill="none" stroke="#9333ea" stroke-width="1.8"/>' +
                        '<circle cx="16" cy="16" r="4" fill="#9333ea" opacity="0.3"/>' +
                        '<path d="M8 16a8 8 0 0116 0" fill="none" stroke="#9333ea" stroke-width="1.5"/>' +
                        '<path d="M10 16a6 6 0 0112 0" fill="none" stroke="#9333ea" stroke-width="1.2" opacity="0.6"/>' +
                    '</svg>' +
                '</div>' +
                '<div class="browser-info">' +
                    '<div class="browser-name">WS 客户端 #' + c.id + ' <small style="color:var(--text-tertiary);font-weight:400">油猴脚本</small></div>' +
                    '<div class="browser-meta">' +
                        '<span class="browser-url">' + esc(ipStr) + '</span>' +
                        '<span class="browser-sep">·</span>' +
                        '<span class="browser-time">' + timeStr + '</span>' +
                        (c.activeRequests > 0 ? '<span class="browser-sep">·</span><span style="color:var(--accent)">请求中</span>' : '') +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="browser-item-right">' +
                '<span class="browser-status ' + statusClass + '">' +
                    '<span class="status-dot-inline" style="background:' + (c.status === 'connected' ? 'var(--success)' : 'var(--text-tertiary)') + ';box-shadow:0 0 4px ' + (c.status === 'connected' ? 'var(--success)44' : 'transparent') + '"></span>' +
                    statusText +
                '</span>' +
            '</div>' +
        '</div>';
    }).join('');
}

async function loadWsClients() {
    try {
        var clients = await window.api.getWsClients();
        _cachedWsClients = clients;
        renderWsClientList(clients);
    } catch (e) {}
}

// 监听主进程推送的 WS 客户端列表更新
window.api.onWsClientListUpdate(function (list) {
    _cachedWsClients = list;
    renderWsClientList(list);
});

// 模型列表从 WS 客户端更新时自动刷新
if (window.api.onModelListUpdate) {
    window.api.onModelListUpdate(function (models) {
        if (models && models.length > 0) {
            renderModelList(models);
            addLog('模型列表已从 WS 客户端更新: ' + models.length + ' 个', 'info');
        }
    });
}

// 切换到客户端管理页时也加载 WS 客户端
var _origLoadBrowsers = loadBrowsers;
loadBrowsers = function () {
    _origLoadBrowsers();
    loadWsClients();
};

// ========== 服务状态监听 — 联动按钮状态 ==========
window.api.onServiceStatus(function (st) {
    isServiceRunning = st.running;
    var ind = document.getElementById('service-status');
    if (!ind) return;
    var dot = ind.querySelector('.status-dot');
    var txt = ind.querySelector('.status-text');
    if (st.running) {
        dot.className = 'status-dot online'; txt.textContent = '运行中';
        addLog('服务已启动，监听端口 ' + (st.port || ''), 'info');

        // 启动后：禁用启动按钮，启用停止按钮
        if (startBtn) {
            startBtn.classList.add('running');
            startBtn.disabled = true;
            startBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z"/></svg> 运行中';
        }
        if (stopBtn) {
            stopBtn.classList.remove('stopped');
            stopBtn.disabled = false;
            stopBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="5" width="10" height="14" rx="3"/></svg> 停止服务';
        }
    } else {
        dot.className = 'status-dot offline'; txt.textContent = '未启动';
        addLog('服务已停止', 'error');

        // 停止后：启用启动按钮，禁用停止按钮
        if (startBtn) {
            startBtn.classList.remove('running');
            startBtn.disabled = false;
            startBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z"/></svg> 启动服务';
        }
        if (stopBtn) {
            stopBtn.classList.add('stopped');
            stopBtn.disabled = true;
            stopBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="5" width="10" height="14" rx="3"/></svg> 停止服务';
        }
    }
});
window.api.onServiceError(function (err) { addLog('服务错误: ' + err, 'error'); });

// ========== 请求劫持状态监听 ==========
window.api.onHijackStatus(function (data) {
    if (data.status === 'waiting_for_trigger' && testResult) {
        testResult.className = 'test-result loading';
        if (data.message && data.message.includes('自动提交')) {
            testResult.textContent = '⏳ 消息已填入浏览器输入框，正在自动提交并监听响应...\n\n若自动提交失败，请在浏览器中手动按 Enter。\n注意：应用选择的模型会替换浏览器中的模型。';
        } else if (data.message && data.message.includes('已填入')) {
            testResult.textContent = '⏳ 消息已填入浏览器输入框！\n\n请在 lmarena.ai 页面按 Enter 键发送，\n代理将自动劫持该请求并替换为测试内容。';
        } else {
            testResult.textContent = '⏳ 等待浏览器交互...\n\n请在 lmarena.ai 页面发送一条消息，\n代理将自动劫持该请求进行测试。';
        }
    } else if (data.status === 'auto_submit_429' && testResult) {
        testResult.className = 'test-result loading';
        testResult.textContent = '⚠️ 自动提交被 reCAPTCHA 拒绝 (429)\n\n请在 lmarena.ai 页面手动按 Enter 键发送消息，\n代理会使用你的真实交互来劫持请求。';
    }
});

// ========== 工具函数 ==========
function esc(text) {
    if (!text) return '';
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(text));
    return d.innerHTML;
}

// ========== 初始化 ==========
(async function init() {
    await loadConfig();
    addLog('应用就绪', 'info');
    // 初始化时尝试加载模型列表
    loadModels();
})();
