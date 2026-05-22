/**
 * PlaneMessageTranslator — placeholder for richer translation between Plane
 * payloads and Cyrus's internal message format.
 *
 * In Linear's adapter this class also maps Linear-specific entities (cycles,
 * teams, projects) to Cyrus core models. For the POC we only need pass-through
 * translation, so this is intentionally minimal. Real implementation comes
 * after H5 (wire edge-worker) when we know which fields the runner reads.
 */
import type { PlaneAgentEvent } from "./types.js";

export class PlaneMessageTranslator {
	/**
	 * No-op for POC — the transport already produces canonical PlaneAgentEvents
	 * via translatePayload. This class is reserved for future enrichment
	 * (e.g. attaching workspace/project metadata, expanding label refs).
	 */
	translate(event: PlaneAgentEvent): PlaneAgentEvent {
		return event;
	}
}
