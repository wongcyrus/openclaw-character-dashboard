const UNAUTHORIZED_EVENT = "openclaw:unauthorized";

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const idToken = localStorage.getItem("idToken");

  if (idToken) {
    headers.set("Authorization", `Bearer ${idToken}`);
  }

  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }

  return response;
}

export async function downloadAuthenticatedFile(
  url: string,
  filename: string,
): Promise<void> {
  const response = await authenticatedFetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}
