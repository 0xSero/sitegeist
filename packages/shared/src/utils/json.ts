export const safeJsonStringify = (value: unknown): string => {
	try {
		if (value === undefined) return "";
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
};
