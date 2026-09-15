'use strict';

const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance in kilometers between two lat/lng points.
 * Good enough for "how far is this produce from me" — no need for a more
 * precise ellipsoidal model at marketplace-listing distances.
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Raw-SQL Haversine expression against a table alias's latitude/longitude
 * columns, for filtering/sorting by distance directly in Postgres rather
 * than pulling every row into Node first. Returns kilometers.
 *
 * No PostGIS/earthdistance extension required — this is plain trig, which
 * is all a marketplace-listing-distance estimate needs and keeps the
 * migration free of extension-enable permissions concerns on managed
 * Postgres (Railway).
 */
function haversineSql(alias, latParamIndex, lngParamIndex) {
  return `(
    ${EARTH_RADIUS_KM} * acos(
      LEAST(1, GREATEST(-1,
        cos(radians($${latParamIndex})) * cos(radians("${alias}"."latitude")) *
        cos(radians("${alias}"."longitude") - radians($${lngParamIndex})) +
        sin(radians($${latParamIndex})) * sin(radians("${alias}"."latitude"))
      ))
    )
  )`;
}

module.exports = { haversineKm, haversineSql, EARTH_RADIUS_KM };
