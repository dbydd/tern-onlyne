import { OnlyneError } from "@onlyne/lib";

export interface JudgeConfig {
	endpoint: string;
	model: string;
	headers?: Record<string, string>;
	timeout_ms?: number;
}

export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string | null>;
}
export interface NoulQuestion {
	type: "noul";
	instructions: string;
	/** The service validates both keys present or both absent; a one-sided record fails at the wire. */
	criteria: { true: string; false: string };
}
export type Question = ChoiceQuestion | NoulQuestion;
export type Answers = Record<string, { choice?: string; noul?: number; type?: string }>;

/** One System One judgment. Failures surface as decision_unavailable, never as a guessed answer. */
export async function judge(
	config: JudgeConfig,
	state: unknown,
	questions: Record<string, Question>,
): Promise<Answers> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeout_ms ?? 30_000);
	let response: Response;
	try {
		response = await fetch(config.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", ...config.headers },
			body: JSON.stringify({ model: config.model, state, questions }),
			signal: controller.signal,
		});
	} catch (error) {
		throw new OnlyneError("decision_unavailable", `The System One endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(timer);
	}
	const text = await response.text();
	if (!response.ok) {
		throw new OnlyneError("decision_unavailable", `The System One endpoint answered HTTP ${String(response.status)}: ${text.slice(0, 300)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new OnlyneError("decision_unavailable", "The System One endpoint returned no JSON object.");
	}
	if (parsed === null || typeof parsed !== "object" || !("answers" in parsed)) {
		throw new OnlyneError("decision_unavailable", "The System One response carried no answers object.");
	}
	const answers = parsed.answers;
	if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
		throw new OnlyneError("decision_unavailable", "The System One response carried no answers object.");
	}
	return answers as Answers;
}

export function choice<T extends string>(answers: Answers, id: string, allowed: readonly T[]): T | undefined {
	const answer = answers[id];
	const value = answer?.choice;
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

export function noul(answers: Answers, id: string): boolean | undefined {
	const value = answers[id]?.noul;
	return typeof value === "number" ? value >= 0.5 : undefined;
}
