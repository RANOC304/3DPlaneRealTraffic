// Local time at an airport.
//
// The route lookup gives a country and a position but no timezone, and shipping
// a coordinate-to-timezone shapefile to the browser for one line of a panel is
// not a trade worth making. So each country is mapped to a representative IANA
// zone — the handful with several zones are split by longitude — and `Intl`
// turns that into the offset actually in force on the day of the flight, which
// is what keeps summer time correct without a rules table of our own.

const singleZoneCountries: Record<string, string> = {
  AD: 'Europe/Andorra', AE: 'Asia/Dubai', AF: 'Asia/Kabul', AG: 'America/Antigua',
  AI: 'America/Anguilla', AL: 'Europe/Tirane', AM: 'Asia/Yerevan', AO: 'Africa/Luanda',
  AR: 'America/Argentina/Buenos_Aires', AS: 'Pacific/Pago_Pago', AT: 'Europe/Vienna',
  AW: 'America/Aruba', AX: 'Europe/Mariehamn', AZ: 'Asia/Baku', BA: 'Europe/Sarajevo',
  BB: 'America/Barbados', BD: 'Asia/Dhaka', BE: 'Europe/Brussels', BF: 'Africa/Ouagadougou',
  BG: 'Europe/Sofia', BH: 'Asia/Bahrain', BI: 'Africa/Bujumbura', BJ: 'Africa/Porto-Novo',
  BL: 'America/St_Barthelemy', BM: 'Atlantic/Bermuda', BN: 'Asia/Brunei', BO: 'America/La_Paz',
  BQ: 'America/Kralendijk', BS: 'America/Nassau', BT: 'Asia/Thimphu', BW: 'Africa/Gaborone',
  BY: 'Europe/Minsk', BZ: 'America/Belize', CC: 'Indian/Cocos', CF: 'Africa/Bangui',
  CG: 'Africa/Brazzaville', CH: 'Europe/Zurich', CI: 'Africa/Abidjan', CK: 'Pacific/Rarotonga',
  CM: 'Africa/Douala', CN: 'Asia/Shanghai', CO: 'America/Bogota', CR: 'America/Costa_Rica',
  CU: 'America/Havana', CV: 'Atlantic/Cape_Verde', CW: 'America/Curacao', CX: 'Indian/Christmas',
  CY: 'Asia/Nicosia', CZ: 'Europe/Prague', DE: 'Europe/Berlin', DJ: 'Africa/Djibouti',
  DK: 'Europe/Copenhagen', DM: 'America/Dominica', DO: 'America/Santo_Domingo', DZ: 'Africa/Algiers',
  EE: 'Europe/Tallinn', EG: 'Africa/Cairo', EH: 'Africa/El_Aaiun', ER: 'Africa/Asmara',
  ET: 'Africa/Addis_Ababa', FI: 'Europe/Helsinki', FJ: 'Pacific/Fiji', FK: 'Atlantic/Stanley',
  FO: 'Atlantic/Faroe', FR: 'Europe/Paris', GA: 'Africa/Libreville', GB: 'Europe/London',
  GD: 'America/Grenada', GE: 'Asia/Tbilisi', GF: 'America/Cayenne', GG: 'Europe/Guernsey',
  GH: 'Africa/Accra', GI: 'Europe/Gibraltar', GM: 'Africa/Banjul', GN: 'Africa/Conakry',
  GP: 'America/Guadeloupe', GQ: 'Africa/Malabo', GR: 'Europe/Athens', GT: 'America/Guatemala',
  GU: 'Pacific/Guam', GW: 'Africa/Bissau', GY: 'America/Guyana', HK: 'Asia/Hong_Kong',
  HN: 'America/Tegucigalpa', HR: 'Europe/Zagreb', HT: 'America/Port-au-Prince', HU: 'Europe/Budapest',
  IE: 'Europe/Dublin', IL: 'Asia/Jerusalem', IM: 'Europe/Isle_of_Man', IN: 'Asia/Kolkata',
  IQ: 'Asia/Baghdad', IR: 'Asia/Tehran', IS: 'Atlantic/Reykjavik', IT: 'Europe/Rome',
  JE: 'Europe/Jersey', JM: 'America/Jamaica', JO: 'Asia/Amman', JP: 'Asia/Tokyo',
  KE: 'Africa/Nairobi', KG: 'Asia/Bishkek', KH: 'Asia/Phnom_Penh', KM: 'Indian/Comoro',
  KN: 'America/St_Kitts', KP: 'Asia/Pyongyang', KR: 'Asia/Seoul', KW: 'Asia/Kuwait',
  KY: 'America/Cayman', KZ: 'Asia/Almaty', LA: 'Asia/Vientiane', LB: 'Asia/Beirut',
  LC: 'America/St_Lucia', LI: 'Europe/Vaduz', LK: 'Asia/Colombo', LR: 'Africa/Monrovia',
  LS: 'Africa/Maseru', LT: 'Europe/Vilnius', LU: 'Europe/Luxembourg', LV: 'Europe/Riga',
  LY: 'Africa/Tripoli', MA: 'Africa/Casablanca', MC: 'Europe/Monaco', MD: 'Europe/Chisinau',
  ME: 'Europe/Podgorica', MF: 'America/Marigot', MG: 'Indian/Antananarivo', MH: 'Pacific/Majuro',
  MK: 'Europe/Skopje', ML: 'Africa/Bamako', MM: 'Asia/Yangon', MO: 'Asia/Macau',
  MP: 'Pacific/Saipan', MQ: 'America/Martinique', MR: 'Africa/Nouakchott', MS: 'America/Montserrat',
  MT: 'Europe/Malta', MU: 'Indian/Mauritius', MV: 'Indian/Maldives', MW: 'Africa/Blantyre',
  MY: 'Asia/Kuala_Lumpur', MZ: 'Africa/Maputo', NA: 'Africa/Windhoek', NC: 'Pacific/Noumea',
  NE: 'Africa/Niamey', NF: 'Pacific/Norfolk', NG: 'Africa/Lagos', NI: 'America/Managua',
  NL: 'Europe/Amsterdam', NO: 'Europe/Oslo', NP: 'Asia/Kathmandu', NR: 'Pacific/Nauru',
  NU: 'Pacific/Niue', NZ: 'Pacific/Auckland', OM: 'Asia/Muscat', PA: 'America/Panama',
  PE: 'America/Lima', PH: 'Asia/Manila', PK: 'Asia/Karachi', PL: 'Europe/Warsaw',
  PM: 'America/Miquelon', PN: 'Pacific/Pitcairn', PR: 'America/Puerto_Rico', PS: 'Asia/Gaza',
  PW: 'Pacific/Palau', PY: 'America/Asuncion', QA: 'Asia/Qatar', RE: 'Indian/Reunion',
  RO: 'Europe/Bucharest', RS: 'Europe/Belgrade', RW: 'Africa/Kigali', SA: 'Asia/Riyadh',
  SB: 'Pacific/Guadalcanal', SC: 'Indian/Mahe', SD: 'Africa/Khartoum', SE: 'Europe/Stockholm',
  SG: 'Asia/Singapore', SH: 'Atlantic/St_Helena', SI: 'Europe/Ljubljana', SJ: 'Arctic/Longyearbyen',
  SK: 'Europe/Bratislava', SL: 'Africa/Freetown', SM: 'Europe/San_Marino', SN: 'Africa/Dakar',
  SO: 'Africa/Mogadishu', SR: 'America/Paramaribo', SS: 'Africa/Juba', ST: 'Africa/Sao_Tome',
  SV: 'America/El_Salvador', SX: 'America/Lower_Princes', SY: 'Asia/Damascus', SZ: 'Africa/Mbabane',
  TC: 'America/Grand_Turk', TD: 'Africa/Ndjamena', TG: 'Africa/Lome', TH: 'Asia/Bangkok',
  TJ: 'Asia/Dushanbe', TK: 'Pacific/Fakaofo', TL: 'Asia/Dili', TM: 'Asia/Ashgabat',
  TN: 'Africa/Tunis', TO: 'Pacific/Tongatapu', TR: 'Europe/Istanbul', TT: 'America/Port_of_Spain',
  TV: 'Pacific/Funafuti', TW: 'Asia/Taipei', TZ: 'Africa/Dar_es_Salaam', UA: 'Europe/Kyiv',
  UG: 'Africa/Kampala', UY: 'America/Montevideo', UZ: 'Asia/Tashkent', VA: 'Europe/Vatican',
  VC: 'America/St_Vincent', VE: 'America/Caracas', VG: 'America/Tortola', VI: 'America/St_Thomas',
  VN: 'Asia/Ho_Chi_Minh', VU: 'Pacific/Efate', WF: 'Pacific/Wallis', WS: 'Pacific/Apia',
  YE: 'Asia/Aden', YT: 'Indian/Mayotte', ZA: 'Africa/Johannesburg', ZM: 'Africa/Lusaka',
  ZW: 'Africa/Harare',
};

// Countries wide enough to keep several clocks. Longitude picks the zone, with
// a latitude test where the border runs east to west rather than north to south.
function multiZoneCountry(iso: string, lat: number, lon: number): string | null {
  switch (iso) {
    case 'US':
      if (lat < 30 && lon < -140) return 'Pacific/Honolulu';
      if (lon < -130) return 'America/Anchorage';
      if (lon < -115) return 'America/Los_Angeles';
      if (lon < -109 && lat < 37) return 'America/Phoenix';
      if (lon < -101.5) return 'America/Denver';
      if (lon < -87.5) return 'America/Chicago';
      return 'America/New_York';
    case 'CA':
      if (lon > -60) return 'America/St_Johns';
      if (lon > -68) return 'America/Halifax';
      if (lon > -90) return 'America/Toronto';
      if (lon > -102) return 'America/Winnipeg';
      if (lon > -110) return 'America/Regina';
      if (lon > -120) return 'America/Edmonton';
      if (lon > -132 || lat < 60) return 'America/Vancouver';
      return 'America/Whitehorse';
    case 'RU':
      if (lon < 25) return 'Europe/Kaliningrad';
      if (lon < 47) return 'Europe/Moscow';
      if (lon < 55) return 'Europe/Samara';
      if (lon < 68) return 'Asia/Yekaterinburg';
      if (lon < 78) return 'Asia/Omsk';
      if (lon < 90) return 'Asia/Novosibirsk';
      if (lon < 103) return 'Asia/Krasnoyarsk';
      if (lon < 115) return 'Asia/Irkutsk';
      if (lon < 128) return 'Asia/Yakutsk';
      if (lon < 140) return 'Asia/Vladivostok';
      if (lon < 155) return 'Asia/Magadan';
      return 'Asia/Kamchatka';
    case 'BR':
      if (lon > -34) return 'America/Noronha';
      if (lon > -54) return 'America/Sao_Paulo';
      if (lon > -68) return 'America/Manaus';
      return 'America/Rio_Branco';
    case 'AU':
      if (lon > 138) return lat > -29 ? 'Australia/Brisbane' : 'Australia/Sydney';
      if (lon > 129) return lat > -26 ? 'Australia/Darwin' : 'Australia/Adelaide';
      return 'Australia/Perth';
    case 'MX':
      if (lon > -90) return 'America/Cancun';
      if (lon > -106) return 'America/Mexico_City';
      if (lon > -114) return lat > 27 ? 'America/Hermosillo' : 'America/Mazatlan';
      return 'America/Tijuana';
    case 'ID':
      if (lon > 131) return 'Asia/Jayapura';
      if (lon > 114.5) return 'Asia/Makassar';
      return 'Asia/Jakarta';
    case 'CL':
      return lon < -85 ? 'Pacific/Easter' : 'America/Santiago';
    case 'EC':
      return lon < -85 ? 'Pacific/Galapagos' : 'America/Guayaquil';
    case 'ES':
      return lon < -13 ? 'Atlantic/Canary' : 'Europe/Madrid';
    case 'PT':
      if (lon < -20) return 'Atlantic/Azores';
      if (lon < -14) return 'Atlantic/Madeira';
      return 'Europe/Lisbon';
    case 'CD':
      return lon < 25 ? 'Africa/Kinshasa' : 'Africa/Lubumbashi';
    case 'MN':
      return lon < 95 ? 'Asia/Hovd' : 'Asia/Ulaanbaatar';
    case 'PG':
      return lon > 154 ? 'Pacific/Bougainville' : 'Pacific/Port_Moresby';
    case 'FM':
      if (lon > 158) return 'Pacific/Kosrae';
      if (lon > 152) return 'Pacific/Pohnpei';
      return 'Pacific/Chuuk';
    case 'KI':
      return lon > 170 || lon < -150 ? 'Pacific/Kiritimati' : 'Pacific/Tarawa';
    case 'PF':
      return 'Pacific/Tahiti';
    case 'GL':
      return 'America/Nuuk';
    default:
      return null;
  }
}

export function airportZone(countryIso: string | null | undefined, lat: number, lon: number) {
  const iso = (countryIso ?? '').trim().toUpperCase();
  if (iso.length === 2) {
    const multi = multiZoneCountry(iso, lat, lon);
    if (multi) return multi;
    const single = singleZoneCountries[iso];
    if (single) return single;
  }
  return null;
}

function zoneOffsetMinutes(zone: string, at: Date) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at);
    const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!match) return name === 'GMT' ? 0 : null;
    const sign = match[1] === '-' ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
  } catch {
    return null;
  }
}

/**
 * Minutes east of UTC at this airport on this date, and the label to print next
 * to it. Falls back to the offset the longitude implies when the country is
 * unknown, which is right to the hour for most of the world and never absurd.
 */
export function airportUtcOffset(
  airport: { countryIso?: string | null; latitude: number; longitude: number },
  at: Date = new Date(),
) {
  const zone = airportZone(airport.countryIso, airport.latitude, airport.longitude);
  const resolved = zone === null ? null : zoneOffsetMinutes(zone, at);
  if (resolved !== null) return { minutes: resolved, zone, estimated: false };
  return {
    minutes: Math.round(airport.longitude / 15) * 60,
    zone: null,
    estimated: true,
  };
}

/** `UTC+05:30`, the way an airport board writes it. */
export function formatUtcOffset(minutes: number) {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

/** Wall-clock time at that offset, 24 hour, to match the rest of the readouts. */
export function formatLocalTime(epochSeconds: number, offsetMinutes: number) {
  return new Date((epochSeconds + offsetMinutes * 60) * 1000).toISOString().slice(11, 16);
}

/**
 * Calendar days between two moments read on their own local clocks — the `+1`
 * an arrival board puts against a flight that lands the day after it left.
 */
export function localDayShift(
  arrivalSeconds: number,
  arrivalOffsetMinutes: number,
  departureSeconds: number,
  departureOffsetMinutes: number,
) {
  const day = (seconds: number, offset: number) => Math.floor((seconds + offset * 60) / 86_400);
  return day(arrivalSeconds, arrivalOffsetMinutes) - day(departureSeconds, departureOffsetMinutes);
}
