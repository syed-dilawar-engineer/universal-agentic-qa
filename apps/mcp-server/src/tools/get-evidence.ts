import {
  GetEvidenceInput,
  GetEvidenceOutput,
  McpServerContext,
  DEFAULT_EVIDENCE_MAX_BYTES,
} from '../types.js';

export async function handleGetEvidence(
  input: GetEvidenceInput,
  context: McpServerContext
): Promise<GetEvidenceOutput> {
  const { evidenceId, encoding = 'metadata_only', maxBytes = DEFAULT_EVIDENCE_MAX_BYTES } = input;

  const artifact = context.storage.getEvidence(evidenceId);
  if (!artifact) {
    return {
      found: false,
      verifiedChecksum: false,
      error: `Evidence artifact with ID '${evidenceId}' was not found in storage.`,
    };
  }

  try {
    const result = await context.storage.readEvidenceContent(evidenceId, {
      encoding,
      maxBytes,
    });

    return {
      found: true,
      artifact: result.artifact,
      verifiedChecksum: result.verifiedChecksum,
      actualSha256: result.actualSha256,
      data: result.data,
      truncated: result.truncated,
    };
  } catch (err: any) {
    return {
      found: true,
      artifact,
      verifiedChecksum: false,
      error: `Failed to read evidence payload: ${err.message}`,
    };
  }
}
