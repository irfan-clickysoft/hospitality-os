/**
 * What is known about the three Sunset properties. One place, used by seed:sunset (rooms) and seed:sunset-rates (prices).
 *
 * REAL (from the owner): the properties, their room counts, the room types each one sells, and the nightly price of each type (the rate card).
 * PLACEHOLDER (not yet given): how many rooms of each type there are at each property (the observation week will settle it), and the
 * extra-person / extra-bed prices, the weekend price and the international uplift. Correct these as they arrive.
 */
export interface RoomTypeDef { code: string; name: string; maxAdults: number; maxOccupancy: number; floor: string; rooms: number; price: string }
export interface PropertyDef { code: string; name: string; city: string; tz: string; firstRoom: number; types: RoomTypeDef[] }

const t = (code: string, name: string, floor: string, rooms: number, price: string, maxAdults = 2, maxOccupancy = 3): RoomTypeDef => ({ code, name, maxAdults, maxOccupancy, floor, rooms, price });

export const PROPERTIES: PropertyDef[] = [
  { code: 'BLVD', name: 'Sunset BnB Boulevard', city: 'Karachi', tz: 'Asia/Karachi', firstRoom: 101, types: [t('STD', 'Standard Room', 'Ground', 2, '12000'), t('DLX', 'Deluxe Room', 'First', 3, '14000'), t('EXE', 'Executive Room', 'Second', 4, '16000')] },   // 9 rooms
  { code: 'CREEK', name: 'Sunset BnB Creek', city: 'Karachi', tz: 'Asia/Karachi', firstRoom: 101, types: [t('STD', 'Standard Room', 'Ground', 3, '12000'), t('EXE', 'Executive Room', 'First', 3, '14000'), t('DLXT', 'Deluxe Triple', 'First', 2, '16000', 3, 3), t('FAM', 'Family Suite', 'Second', 2, '20000', 4, 5)] },   // 10 rooms
  { code: 'RAMNA', name: 'Sunset BnB Ramna', city: 'Islamabad', tz: 'Asia/Karachi', firstRoom: 101, types: [t('STD', 'Standard Room', 'Ground', 3, '12000'), t('DLX', 'Deluxe Room', 'First', 3, '14000'), t('EXE', 'Executive Room', 'Second', 2, '16000')] },   // 8 rooms
];
