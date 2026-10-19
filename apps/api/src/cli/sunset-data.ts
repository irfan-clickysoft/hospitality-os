/**
 * What is known about the three Sunset properties. One place, used by seed:sunset (rooms) and seed:sunset-rates (prices).
 *
 * REAL (from the owner): the properties, the room types each one sells, which room NUMBER is which type and on which floor, the nightly price of
 * each type (the rate card), the extra-person and extra-mattress prices, and that weekend and weekday prices are the same.
 * STILL PLACEHOLDER: how many people each type sleeps, and the foreign-guest price (for now the same as local: the international plan is +0%, to be changed here or on the Rates screen).
 */
export type FloorName = 'Basement' | 'Ground floor' | 'Floor 1';
export interface RoomTypeDef { code: string; name: string; maxAdults: number; maxOccupancy: number; price: string; floors: Array<[FloorName, string[]]> }
export interface PropertyDef { code: string; name: string; city: string; tz: string; floorOrder: FloorName[]; types: RoomTypeDef[] }

/** Per head, per night: an extra person (breakfast included), and an extra mattress. Children are charged as extra persons until the owner says otherwise. */
export const EXTRAS = { extraAdult: '2500', extraChild: '2500', extraBed: '1500' };
/** The international plan's uplift on the local price, in basis points. 0 for now: foreign and local guests pay the same. */
export const INTERNATIONAL_UPLIFT_BP = 0;

const t = (code: string, name: string, price: string, floors: Array<[FloorName, string[]]>, maxAdults = 2, maxOccupancy = 3): RoomTypeDef => ({ code, name, maxAdults, maxOccupancy, price, floors });

export const PROPERTIES: PropertyDef[] = [
  { code: 'BLVD', name: 'Sunset BnB Boulevard', city: 'Karachi', tz: 'Asia/Karachi', floorOrder: ['Ground floor', 'Floor 1'], types: [   // 9 rooms
    t('STD', 'Standard Room', '12000', [['Ground floor', ['104']], ['Floor 1', ['204']]]), t('DLX', 'Deluxe Room', '14000', [['Ground floor', ['103']], ['Floor 1', ['203', '205']]]),
    t('EXE', 'Executive Room', '16000', [['Ground floor', ['101', '102']], ['Floor 1', ['201', '202']]])] },
  { code: 'CREEK', name: 'Sunset BnB Creek', city: 'Karachi', tz: 'Asia/Karachi', floorOrder: ['Ground floor', 'Floor 1'], types: [   // 10 rooms
    t('STD', 'Standard Room', '12000', [['Floor 1', ['204']]]), t('EXE', 'Executive Room', '14000', [['Ground floor', ['101', '102', '104']], ['Floor 1', ['201', '202']]]),
    t('DLXT', 'Deluxe Triple', '16000', [['Ground floor', ['103']], ['Floor 1', ['203']]], 3, 3), t('FAM', 'Family Suite', '20000', [['Ground floor', ['105']], ['Floor 1', ['205']]], 4, 5)] },
  // Ramna: the owner's list gave 101 and 102 twice (Executive and Standard on floor 1, as well as Deluxe on the ground floor). Numbers must be unique, so those two floor-1 rooms are entered
  // as 201 and 202 — TO BE CONFIRMED with the owner.
  { code: 'RAMNA', name: 'Sunset BnB Ramna', city: 'Islamabad', tz: 'Asia/Karachi', floorOrder: ['Basement', 'Ground floor', 'Floor 1'], types: [   // 8 rooms
    t('STD', 'Standard Room', '12000', [['Basement', ['002']], ['Floor 1', ['202']]]), t('DLX', 'Deluxe Room', '14000', [['Basement', ['003']], ['Ground floor', ['101', '102']], ['Floor 1', ['203']]]),
    t('EXE', 'Executive Room', '16000', [['Basement', ['001']], ['Floor 1', ['201']]])] },
];
export const roomsOf = (p: PropertyDef) => p.types.reduce((a, ty) => a + ty.floors.reduce((b, [, n]) => b + n.length, 0), 0);

/**
 * The tax matrix the owner gave (rates as a percentage of the base price). Entered as drafts by seed:sunset-tax; approval is a separate step.
 * Not in the matrix, therefore untaxed until the owner says otherwise: extra bed/person (ROOM_EXTRAS is taxed here as part of accommodation — to be confirmed),
 * minibar, miscellaneous, cancellation and no-show fees. Karachi laundry is exempt in-house (no rate).
 */
export interface TaxCodeDef { code: string; name: string; rateBp: number; appliesTo: string[] }
export interface ReviewDef { txnCode: string; kind: 'WHT_REVIEW' | 'VENDOR_VERIFICATION'; message: string }
export interface TaxAreaDef { jurisdiction: string; authority: string; propertyCodes: string[]; codes: TaxCodeDef[]; reviews: ReviewDef[] }
export const TAX_MATRIX: TaxAreaDef[] = [
  { jurisdiction: 'FBR-ICT', authority: 'Federal Board of Revenue (FBR), Islamabad', propertyCodes: ['RAMNA'], reviews: [{ txnCode: 'TRANSPORT_THIRDPARTY', kind: 'WHT_REVIEW', message: 'Third-party transport: review withholding tax before paying the vendor.' }],
    codes: [
      { code: 'ICT-ST15', name: 'Islamabad sales tax on services 15%', rateBp: 1500, appliesTo: ['ROOM', 'ROOM_EXTRAS', 'FNB', 'HALL', 'TRANSPORT_OWNED', 'TRANSPORT_THIRDPARTY', 'LAUNDRY'] },
      { code: 'ICT-ST5D', name: 'Islamabad sales tax on food paid digitally 5%', rateBp: 500, appliesTo: ['FNB_DIGITAL'] }] },
  { jurisdiction: 'SRB', authority: 'Sindh Revenue Board (SRB), Karachi', propertyCodes: ['BLVD', 'CREEK'], reviews: [{ txnCode: 'TRANSPORT_THIRDPARTY', kind: 'VENDOR_VERIFICATION', message: 'Third-party transport: verify the vendor (registration) before paying.' }],
    codes: [
      { code: 'SRB-ST15', name: 'Sindh sales tax on services 15%', rateBp: 1500, appliesTo: ['ROOM', 'ROOM_EXTRAS', 'FNB', 'HALL'] },
      { code: 'SRB-ST8D', name: 'Sindh sales tax 8% (food paid digitally, transport)', rateBp: 800, appliesTo: ['FNB_DIGITAL', 'TRANSPORT_OWNED', 'TRANSPORT_THIRDPARTY'] }] },
];
