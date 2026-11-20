/** Licence claim far in the future, so shared API test events are licensed. */
export const LICENCE_VALID = '2999-01-01T00:00:00+00:00';

/** JWT claims for a test event: the given sub plus a valid licence claim. */
export const claimsFor = (sub: string): Record<string, string> => ({ sub, lic_cognifly: LICENCE_VALID });
