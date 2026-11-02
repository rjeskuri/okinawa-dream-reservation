// The Drive API client: lists a folder and downloads a file. The token and fetch are injected, so the file runs unchanged
// in Node and in Workers. Unlike the Sheets client it does not retry: each attempt spends one of the call's subrequests,
// and the photo sync picks up whatever failed on its next call.

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  /** Absent for anything Drive does not store as bytes, such as a Google Doc. */
  md5Checksum?: string;
  /** Absent like md5Checksum. */
  size?: number;
};

export type DriveClient = {
  listFolder(folderId: string): Promise<DriveFile[]>;
  download(fileId: string): Promise<ArrayBuffer>;
};

type DriveClientOptions = {
  getToken: () => Promise<string>;
  fetch: typeof fetch;
};

/** A file as Drive sends it, with int64 values as JSON strings. */
type ListedFile = Omit<DriveFile, "size"> & { size?: string };

const API = "https://www.googleapis.com/drive/v3/files";

// These fields leave out nextPageToken, so a listing stops at its first PAGE_SIZE files.
const LIST_FIELDS = "files(id,name,mimeType,md5Checksum,size)";

const PAGE_SIZE = "1000";

/** Carries the HTTP status and nothing from the response body, which can quote the bearer token. */
export class DriveError extends Error {
  readonly status: number;

  constructor(status: number, message = `Drive request failed with status ${status}`) {
    super(message);
    this.name = "DriveError";
    this.status = status;
  }
}

/** A 200 of any other shape throws rather than reading as an empty folder, without the text JSON.parse would quote. */
function filesIn(text: string): ListedFile[] {
  try {
    const { files } = JSON.parse(text);
    if (Array.isArray(files)) return files;
  } catch {
    // Falls through to the error below.
  }
  throw new DriveError(200, "Drive response has no files");
}

function toDriveFile({ size, ...file }: ListedFile): DriveFile {
  return size === undefined ? file : { ...file, size: Number(size) };
}

// `fetch` is destructured because workerd's throws "Illegal invocation" when it is called as `options.fetch(...)`.
export function createDriveClient({ getToken, fetch }: DriveClientOptions): DriveClient {
  async function get(url: string): Promise<Response> {
    const token = await getToken();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.ok) return response;
    // Read to free the connection. It never goes into the error: it can quote the token.
    await response.text();
    throw new DriveError(response.status);
  }

  return {
    async listFolder(folderId) {
      const query = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: LIST_FIELDS,
        pageSize: PAGE_SIZE,
      });
      const response = await get(`${API}?${query}`);
      return filesIn(await response.text()).map(toDriveFile);
    },

    async download(fileId) {
      const response = await get(`${API}/${encodeURIComponent(fileId)}?alt=media`);
      return response.arrayBuffer();
    },
  };
}
