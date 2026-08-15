import type { App } from 'obsidian';

/**
 * An optional bridge to the TaskNotes plugin, used to make the views this
 * plugin already has behave correctly on notes TaskNotes owns.
 *
 * This is deliberately not an attempt to be a task plugin. It exists because a
 * board that writes `status: done` straight into frontmatter is *wrong* on a
 * TaskNotes note: TaskNotes normalises the value, stamps the completion date,
 * runs its recurrence and scheduling side effects, and fires the events its own
 * automations listen to. Writing behind its back skips all of that and leaves
 * the vault in a state TaskNotes never agreed to.
 *
 * Everything here is optional and degrades silently. With TaskNotes absent,
 * disabled, or on an API version this does not know, `resolve` returns null and
 * every caller keeps its existing behaviour.
 */

/** The minimum shape of `app.plugins`, which is not in the public typings. */
interface PluginRegistry {
	plugins?: { plugins?: Record<string, unknown> };
}

/** A configured status or priority, as TaskNotes stores it in its settings. */
export interface TaskNotesChoice {
	value: string;
	label: string;
	color?: string;
	/** Statuses sort on `order`, priorities on `weight`. */
	order: number;
	isCompleted?: boolean;
}

interface RawChoice {
	value?: unknown;
	label?: unknown;
	color?: unknown;
	order?: unknown;
	weight?: unknown;
	isCompleted?: unknown;
}

interface RawField {
	id?: unknown;
	frontmatterKey?: unknown;
	writable?: unknown;
}

interface TaskNotesApi {
	apiVersion?: unknown;
	catalog?: {
		statuses?: () => RawChoice[];
		priorities?: () => RawChoice[];
		fields?: () => RawField[];
	};
	tasks?: {
		get?: (path: string) => Promise<unknown>;
		update?: (path: string, patch: Record<string, unknown>, options?: unknown) => Promise<unknown>;
		setStatus?: (path: string, value: unknown, options?: unknown) => Promise<unknown>;
		setPriority?: (path: string, value: unknown, options?: unknown) => Promise<unknown>;
		setDue?: (path: string, value: unknown, options?: unknown) => Promise<unknown>;
		setScheduled?: (path: string, value: unknown, options?: unknown) => Promise<unknown>;
	};
}

/**
 * The API version this was written against. TaskNotes documents `apiVersion`
 * as the compatibility signal, so a future major is treated as "not present"
 * rather than being called optimistically and failing mid-write.
 */
const SUPPORTED_API_VERSION = 1;

/** Recorded on every mutation so a TaskNotes user can see where it came from. */
const MUTATION_SOURCE = 'more-bases-views';

/** The fields with a dedicated setter, which does more than a generic patch. */
const DEDICATED_SETTERS = ['status', 'priority', 'due', 'scheduled'] as const;

export class TaskNotesBridge {
	private fieldsByKey: Map<string, string> | null = null;
	private readonly choiceCache = new Map<string, TaskNotesChoice[] | null>();

	private constructor(private readonly api: TaskNotesApi) {}

	/** Null whenever TaskNotes cannot be used, which is the normal case. */
	static resolve(app: App): TaskNotesBridge | null {
		const registry = app as unknown as PluginRegistry;
		const plugin = registry.plugins?.plugins?.tasknotes as { api?: TaskNotesApi } | undefined;
		const api = plugin?.api;
		if (!api || typeof api.apiVersion !== 'number') return null;
		if (api.apiVersion !== SUPPORTED_API_VERSION) return null;
		if (!api.tasks?.get) return null;
		return new TaskNotesBridge(api);
	}

	/**
	 * The TaskNotes field a frontmatter key belongs to, or null. The mapping is
	 * read from the catalog rather than assumed, because a user can rename any
	 * of these keys in TaskNotes' field mapping and often does.
	 */
	fieldForKey(frontmatterKey: string): string | null {
		if (!this.fieldsByKey) {
			this.fieldsByKey = new Map();
			for (const field of this.api.catalog?.fields?.() ?? []) {
				if (field.writable !== true) continue;
				if (typeof field.id !== 'string' || typeof field.frontmatterKey !== 'string') continue;
				this.fieldsByKey.set(field.frontmatterKey.toLocaleLowerCase(), field.id);
			}
		}
		return this.fieldsByKey.get(frontmatterKey.toLocaleLowerCase()) ?? null;
	}

	/**
	 * The values a field is allowed to take, in the order TaskNotes shows them.
	 * Only status and priority are enumerable; everything else is open text and
	 * answers null.
	 */
	choices(fieldId: string): TaskNotesChoice[] | null {
		const cached = this.choiceCache.get(fieldId);
		if (cached !== undefined) return cached;

		const raw = fieldId === 'status'
			? this.api.catalog?.statuses?.()
			: fieldId === 'priority'
				? this.api.catalog?.priorities?.()
				: undefined;

		const choices = raw?.length ? raw.map(toChoice).filter(isChoice) : null;
		// Sorted here rather than trusted, since `order` and `weight` are just
		// numbers in a settings file and nothing enforces that they are sorted.
		choices?.sort((a, b) => a.order - b.order);
		this.choiceCache.set(fieldId, choices ?? null);
		return choices ?? null;
	}

	/** True only for a note TaskNotes actually manages as a task. */
	async isTask(path: string): Promise<boolean> {
		try {
			return Boolean(await this.api.tasks?.get?.(path));
		} catch {
			return false;
		}
	}

	/**
	 * Writes a field through TaskNotes, returning false when it could not, so
	 * the caller can fall back to its own write rather than dropping the edit.
	 *
	 * The dedicated setters are preferred over the generic patch because they
	 * carry the per-field behaviour: setting a completed status stamps the
	 * completion date, and setting `scheduled` moves the recurrence anchor with
	 * it. A generic patch of the same value does neither.
	 */
	async setField(path: string, fieldId: string, value: unknown): Promise<boolean> {
		const tasks = this.api.tasks;
		if (!tasks) return false;
		const options = { source: MUTATION_SOURCE };

		try {
			if (!await this.isTask(path)) return false;

			if (isDedicated(fieldId)) {
				const setter = fieldId === 'status' ? tasks.setStatus
					: fieldId === 'priority' ? tasks.setPriority
						: fieldId === 'due' ? tasks.setDue
							: tasks.setScheduled;
				if (setter) {
					await setter(path, value, options);
					return true;
				}
			}

			if (!tasks.update) return false;
			await tasks.update(path, { [fieldId]: value }, options);
			return true;
		} catch (error) {
			console.error('[Views] TaskNotes write failed, falling back to frontmatter', error);
			return false;
		}
	}
}

function isDedicated(fieldId: string): fieldId is (typeof DEDICATED_SETTERS)[number] {
	return (DEDICATED_SETTERS as readonly string[]).includes(fieldId);
}

function toChoice(raw: RawChoice): TaskNotesChoice | null {
	if (typeof raw.value !== 'string' || !raw.value) return null;
	// A status sorts on `order` and a priority on `weight`. Both are read here
	// so one shape covers the two catalogs.
	const order = typeof raw.order === 'number' ? raw.order
		: typeof raw.weight === 'number' ? raw.weight
			: 0;
	return {
		value: raw.value,
		label: typeof raw.label === 'string' && raw.label ? raw.label : raw.value,
		color: typeof raw.color === 'string' && raw.color ? raw.color : undefined,
		order,
		isCompleted: raw.isCompleted === true,
	};
}

function isChoice(value: TaskNotesChoice | null): value is TaskNotesChoice {
	return value !== null;
}
