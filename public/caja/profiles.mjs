export const storeProfiles = Object.freeze([
  { id: '10000000-0000-4000-8000-000000000001', name: 'Librería Valencia', slug: 'libreria-valencia' },
  { id: '10000000-0000-4000-8000-000000000002', name: 'Electrónica Valencia', slug: 'electronica-valencia' },
  { id: '10000000-0000-4000-8000-000000000003', name: 'Decoraciones Valencia', slug: 'decoraciones-valencia' },
]);

export const defaultStoreId = storeProfiles[0].id;
export const getStoreProfile = id => storeProfiles.find(profile => profile.id === id) || null;
export function inventoryNamespace(ownerId, storeId) {
  const profile = getStoreProfile(storeId);
  if (!profile) return null;
  return profile.id === defaultStoreId ? ownerId : `${ownerId}:${profile.id}`;
}
