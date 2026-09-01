const accessByClient = new WeakMap();

export function registerAccessControl(client, accessControl) {
  if (client && accessControl) accessByClient.set(client, accessControl);
}

export function unregisterAccessControl(client) {
  if (client) accessByClient.delete(client);
}

export function getAccessControl(client) {
  return client ? accessByClient.get(client) ?? null : null;
}
