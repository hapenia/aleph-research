// Fixture: suppression hides the type error instead of proving the claim.
// @ts-expect-error the value is deliberately mistyped
export const broken: number = 'not a number'
