type BrowserDnrApi = {
	updateDynamicRules?: (rules: {
		removeRuleIds: number[];
		addRules: Array<Record<string, unknown>>;
	}) => Promise<void> | void;
	RuleActionType?: { MODIFY_HEADERS?: string };
	HeaderOperation?: { SET?: string };
	ResourceType?: { XMLHTTPREQUEST?: string };
};

const KIMI_DNR_RULE_ID = 9000;
const KIMI_UA_VALUE = "coding-agent";

export async function setupKimiUserAgentHeaderSupport(): Promise<{
	ok: boolean;
	reason?: string;
}> {
	const dnr = (chrome as unknown as { declarativeNetRequest?: BrowserDnrApi }).declarativeNetRequest;
	if (
		typeof dnr?.updateDynamicRules !== "function" ||
		!dnr?.RuleActionType?.MODIFY_HEADERS ||
		!dnr?.HeaderOperation?.SET ||
		!dnr?.ResourceType?.XMLHTTPREQUEST
	) {
		return { ok: false, reason: "declarativeNetRequest header rewrite API unavailable" };
	}

	try {
		await dnr.updateDynamicRules?.({
			removeRuleIds: [KIMI_DNR_RULE_ID],
			addRules: [
				{
					id: KIMI_DNR_RULE_ID,
					priority: 1,
					action: {
						type: dnr.RuleActionType.MODIFY_HEADERS,
						requestHeaders: [
							{
								header: "User-Agent",
								operation: dnr.HeaderOperation.SET,
								value: KIMI_UA_VALUE,
							},
						],
					},
					condition: {
						urlFilter: "||api.kimi.com",
						resourceTypes: [dnr.ResourceType.XMLHTTPREQUEST],
					},
				},
			],
		});
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error ?? "Failed to install Kimi DNR rule"),
		};
	}
}
