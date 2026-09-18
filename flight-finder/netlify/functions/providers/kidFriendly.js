/* Manually maintained — not derived from any API. Add/remove IATA codes as
   the family's opinion of "kid-friendly" changes. Shared by the backend
   (to tag results) and by nothing else — the frontend just reads the flag
   Netlify Functions send back. */
export const KID_FRIENDLY_CODES = new Set([
  'MCO', // Orlando
  'LAX', // LA / Disneyland
  'SAN', // San Diego (zoo, Legoland)
  'HNL', // Honolulu
  'CUN', // Cancun (resorts)
  'PUJ', // Punta Cana (resorts)
  'SJU', // San Juan
  'NAS', // Nassau
  'MCI', // Kansas City
  'DEN', // Denver (mountains)
  'SEA', // Seattle
  'YYZ', // Toronto (Zoo, CN Tower)
  'CDG', // Paris (Disneyland Paris)
]);

export const isKidFriendly = (code) => KID_FRIENDLY_CODES.has(code);
