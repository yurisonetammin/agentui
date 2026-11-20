import type { ExtensionUiRequest } from './types'

export function enqueueUiRequest(
  queue: ExtensionUiRequest[],
  req: ExtensionUiRequest,
): ExtensionUiRequest[] {
  const idx = queue.findIndex((item) => item.id === req.id)
  if (idx === -1) return [...queue, req]
  const next = [...queue]
  next[idx] = req
  return next
}

export function dequeueUiRequest(
  queue: ExtensionUiRequest[],
  id: string,
): ExtensionUiRequest[] {
  const next = queue.filter((item) => item.id !== id)
  return next.length === queue.length ? queue : next
}

export function pruneUiRequestsForThread(
  queue: ExtensionUiRequest[],
  threadId: string,
): ExtensionUiRequest[] {
  const next = queue.filter((item) => item.threadId !== threadId)
  return next.length === queue.length ? queue : next
}
