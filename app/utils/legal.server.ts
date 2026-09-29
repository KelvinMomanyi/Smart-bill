const DEFAULT_EFFECTIVE_DATE = "September 27, 2026";

function optionalSetting(name: string) {
  return process.env[name]?.trim() || null;
}

export type PublicLegalDetails = ReturnType<typeof getPublicLegalDetails>;

export function getPublicLegalDetails() {
  return {
    operatorName: optionalSetting("LEGAL_OPERATOR_NAME") || "SmartBill",
    supportEmail: optionalSetting("PUBLIC_SUPPORT_EMAIL"),
    postalAddress: optionalSetting("LEGAL_POSTAL_ADDRESS"),
    governingLaw: optionalSetting("LEGAL_GOVERNING_LAW"),
    effectiveDate:
      optionalSetting("LEGAL_EFFECTIVE_DATE") || DEFAULT_EFFECTIVE_DATE,
  };
}
