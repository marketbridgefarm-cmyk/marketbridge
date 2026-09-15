'use strict';

// Mirrors the Region enum in schema.prisma. Kept as a single ordered list
// (roughly north-to-south, largest/most agriculturally relevant regions
// first) with a human-readable label, so both listings.js validation and
// GET /listings/meta/regions (which the frontend dropdown fetches from)
// stay in sync with the database enum without duplicating the list.
const REGIONS = [
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

const REGION_VALUES = REGIONS.map((r) => r.value);

module.exports = { REGIONS, REGION_VALUES };
