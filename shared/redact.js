// Removes anything that looks like an Anthropic OAuth/API token from text.
// Used by the engine and the extension before any text is logged or shown.

const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]+/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;

/**
 * @param {unknown} text
 * @param {number} [max] maximum length of the result (0 = unlimited)
 * @returns {string}
 */
export function redact(text, max = 0) {
    let s = String(text ?? '');
    s = s.replace(TOKEN_RE, 'sk-ant-***').replace(BEARER_RE, '$1***');
    if (max > 0 && s.length > max)
        s = `${s.slice(0, max - 1)}…`;
    return s;
}
