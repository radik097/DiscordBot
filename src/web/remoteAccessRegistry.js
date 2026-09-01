const remoteAccessByClient = new WeakMap();

export function registerRemoteAccess(client, remoteAccess) {
  if (!client || !remoteAccess) throw new TypeError("Нужны Discord-клиент и RemoteAccess");
  remoteAccessByClient.set(client, remoteAccess);
}

export function getRemoteAccess(client) {
  return client ? remoteAccessByClient.get(client) ?? null : null;
}

export function unregisterRemoteAccess(client, remoteAccess) {
  if (!client) return;
  if (!remoteAccess || remoteAccessByClient.get(client) === remoteAccess) {
    remoteAccessByClient.delete(client);
  }
}
