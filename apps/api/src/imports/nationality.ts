/** Spreadsheets say "Pakistan", "Pakistani" or "PK". Returns the ISO 3166 alpha-2 code, or null when it is not recognised (the row is then reported, never guessed). */
const NAMES: Record<string, string> = {
  pakistan: 'PK', pakistani: 'PK', 'united kingdom': 'GB', uk: 'GB', british: 'GB', england: 'GB', 'great britain': 'GB', 'united states': 'US', usa: 'US', american: 'US', 'united states of america': 'US',
  canada: 'CA', canadian: 'CA', australia: 'AU', australian: 'AU', india: 'IN', indian: 'IN', china: 'CN', chinese: 'CN', afghanistan: 'AF', afghan: 'AF', bangladesh: 'BD', bangladeshi: 'BD',
  'sri lanka': 'LK', 'sri lankan': 'LK', nepal: 'NP', nepali: 'NP', iran: 'IR', iranian: 'IR', turkey: 'TR', turkish: 'TR', turkiye: 'TR', 'saudi arabia': 'SA', saudi: 'SA',
  'united arab emirates': 'AE', uae: 'AE', emirati: 'AE', qatar: 'QA', qatari: 'QA', kuwait: 'KW', kuwaiti: 'KW', oman: 'OM', omani: 'OM', bahrain: 'BH', bahraini: 'BH',
  germany: 'DE', german: 'DE', france: 'FR', french: 'FR', italy: 'IT', italian: 'IT', spain: 'ES', spanish: 'ES', netherlands: 'NL', dutch: 'NL', japan: 'JP', japanese: 'JP',
  korea: 'KR', 'south korea': 'KR', korean: 'KR', malaysia: 'MY', malaysian: 'MY', indonesia: 'ID', indonesian: 'ID', egypt: 'EG', egyptian: 'EG', nigeria: 'NG', nigerian: 'NG',
  'south africa': 'ZA', kenya: 'KE', kenyan: 'KE', russia: 'RU', russian: 'RU', azerbaijan: 'AZ', azerbaijani: 'AZ', uzbekistan: 'UZ', uzbek: 'UZ', kazakhstan: 'KZ', kazakh: 'KZ',
};
export function nationalityCode(raw: string | null | undefined): string | null | undefined {
  const v = (raw ?? '').trim();
  if (!v) return undefined;                                  // blank: no nationality given
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return NAMES[v.toLowerCase().replace(/\s+/g, ' ')] ?? null;
}
