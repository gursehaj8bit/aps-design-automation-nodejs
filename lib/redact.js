// Hides secret values from text that is about to be printed or thrown.
//
// BY VALUE, NOT BY PATTERN. Each secret is registered as it comes into being (a client secret
// from the environment, a token from a sign-in, a signed URL or cookie from an answer) and only
// those exact strings are replaced. Guessing by shape masked ordinary paths: a folder named by a
// UUID or a sha256 looks like a token and is not one.

/// Shorter values are not registered: replacing a two-letter string would garble every message
/// without hiding anything worth hiding.
const MIN_SECRET_LENGTH = 8;

const MASK = '<redacted>';

/// { add(value), redact(text) }. add() takes a string (or ignores anything else); redact() answers
/// the text with every registered value, and its URI-encoded form, replaced by <redacted>.
function createRedactor() {
    const secrets = new Set();
    function add(value) {
        if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH)
            return (value);
        secrets.add(value);
        const encoded = encodeURIComponent(value);
        if (encoded !== value)
            secrets.add(encoded);
        return (value);
    }
    function redact(text) {
        let s = String(text);
        // Longest first, so a secret that contains another is hidden whole.
        for (const v of Array.from(secrets).sort((a, b) => b.length - a.length))
            s = s.split(v).join(MASK);
        return (s);
    }
    return ({ add: add, redact: redact });
}

module.exports = {
    MASK,
    MIN_SECRET_LENGTH,
    createRedactor
};
