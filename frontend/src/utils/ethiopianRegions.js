// Mirrors backend/src/utils/ethiopianRegions.js and the Region enum in
// schema.prisma. Shipped as a frontend constant (not fetched-only) because
// it's small, static data — the two region <select> dropdowns should never
// be empty just because a single network call had a hiccup. GET
// /listings/meta/regions is still called on mount as a background sync in
// case the backend list changes, but this is the default the dropdown
// renders with immediately and falls back to if that call fails.
export const REGIONS = [
  { value: 'TIGRAY', label: 'Tigray' },
  { value: 'AFAR', label: 'Afar' },
  { value: 'AMHARA', label: 'Amhara' },
  { value: 'OROMIA', label: 'Oromia' },
  { value: 'SOMALI', label: 'Somali' },
  { value: 'BENISHANGUL_GUMUZ', label: 'Benishangul-Gumuz' },
  { value: 'GAMBELA', label: 'Gambela' },
  { value: 'HARARI', label: 'Harari' },
  { value: 'SIDAMA', label: 'Sidama' },
  { value: 'SOUTH_ETHIOPIA', label: 'South Ethiopia' },
  { value: 'SOUTH_WEST_ETHIOPIA_PEOPLES', label: "South West Ethiopia Peoples'" },
  { value: 'CENTRAL_ETHIOPIA', label: 'Central Ethiopia' },
  { value: 'ADDIS_ABABA', label: 'Addis Ababa' },
  { value: 'DIRE_DAWA', label: 'Dire Dawa' },
];
