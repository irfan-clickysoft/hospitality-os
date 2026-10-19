/**
 * What is known about the three Sunset properties. One place, used by seed:sunset (rooms) and seed:sunset-rates (prices).
 *
 * REAL (from the owner): the properties, the room types each one sells, how many rooms of each type are on which floor, and the nightly price
 * of each type (the rate card).
 * STILL PLACEHOLDER: the room NUMBERS (they run 101, 102… in the order below until the owner says which number is which room), how many people each
 * type sleeps, and the extra-person / extra-bed prices, the weekend price and the international uplift.
 */
export type FloorName = 'Basement' | 'Ground floor' | 'Floor 1';
export interface RoomTypeDef { code: string; name: string; maxAdults: number; maxOccupancy: number; price: string; floors: Array<[FloorName, number]> }
export interface PropertyDef { code: string; name: string; city: string; tz: string; firstRoom: number; floorOrder: FloorName[]; types: RoomTypeDef[] }

const t = (code: string, name: string, price: string, floors: Array<[FloorName, number]>, maxAdults = 2, maxOccupancy = 3): RoomTypeDef => ({ code, name, maxAdults, maxOccupancy, price, floors });

export const PROPERTIES: PropertyDef[] = [
  { code: 'BLVD', name: 'Sunset BnB Boulevard', city: 'Karachi', tz: 'Asia/Karachi', firstRoom: 101, floorOrder: ['Ground floor', 'Floor 1'], types: [   // 9 rooms
    t('STD', 'Standard Room', '12000', [['Ground floor', 1], ['Floor 1', 1]]), t('DLX', 'Deluxe Room', '14000', [['Ground floor', 1], ['Floor 1', 2]]), t('EXE', 'Executive Room', '16000', [['Ground floor', 2], ['Floor 1', 2]])] },
  { code: 'CREEK', name: 'Sunset BnB Creek', city: 'Karachi', tz: 'Asia/Karachi', firstRoom: 101, floorOrder: ['Ground floor', 'Floor 1'], types: [   // 10 rooms
    t('STD', 'Standard Room', '12000', [['Floor 1', 1]]), t('EXE', 'Executive Room', '14000', [['Ground floor', 3], ['Floor 1', 2]]),
    t('DLXT', 'Deluxe Triple', '16000', [['Ground floor', 1], ['Floor 1', 1]], 3, 3), t('FAM', 'Family Suite', '20000', [['Ground floor', 1], ['Floor 1', 1]], 4, 5)] },
  { code: 'RAMNA', name: 'Sunset BnB Ramna', city: 'Islamabad', tz: 'Asia/Karachi', firstRoom: 101, floorOrder: ['Basement', 'Ground floor', 'Floor 1'], types: [   // 8 rooms
    t('STD', 'Standard Room', '12000', [['Basement', 1], ['Floor 1', 1]]), t('DLX', 'Deluxe Room', '14000', [['Basement', 1], ['Ground floor', 2], ['Floor 1', 1]]), t('EXE', 'Executive Room', '16000', [['Basement', 1], ['Floor 1', 1]])] },
];
export const roomsOf = (p: PropertyDef) => p.types.reduce((a, ty) => a + ty.floors.reduce((b, [, n]) => b + n, 0), 0);

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
