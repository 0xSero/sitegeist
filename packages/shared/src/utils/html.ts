const coerce = (value: unknown) => (value == null ? "" : String(value));

export const escapeHtmlBasic = (value: unknown): string => {
	const text = coerce(value);
	// Must escape '&' first.
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
};

export const escapeHtml = (value: unknown): string => {
	return escapeHtmlBasic(value).replace(/\n/g, "<br>");
};

export const escapeAttribute = (value: unknown): string => {
	// escapeHtmlBasic already handles quotes.
	return escapeHtmlBasic(value);
};
