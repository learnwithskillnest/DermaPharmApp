import { resetTestDb } from '../helpers.ts';

export default async function globalSetup() {
  await resetTestDb();
}
