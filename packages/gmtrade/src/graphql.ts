/** POSTs a GraphQL query; throws on HTTP errors, GraphQL errors and timeouts. */
export async function graphql<T>(url: string, query: string, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`${url}: ${body.errors.map((e) => e.message).join('; ')}`);
  if (!body.data) throw new Error(`${url}: empty response`);
  return body.data;
}
