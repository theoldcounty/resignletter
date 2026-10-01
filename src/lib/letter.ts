/**
 * Data contract shared by the letter form and the client-side generation flow.
 * Keeping this shape centralized helps UI and API callers agree on field names.
 */
export interface LetterFormData {
  /** Person signing the letter; used to personalize the closing and header. */
  senderName: string;
  /** Recipient's name, when supplied, for the letter salutation. */
  managerName: string;
  /** Employer name referenced in the resignation text. */
  company: string;
  /** User-selected final working date, passed through for letter generation. */
  lastDay: string;
  /** Optional user-provided context for the generated wording. */
  reason: string;
  /** Sender's return address, used in printable letter output. */
  homeAddress: string;
  /** Employer's address, used in printable letter output. */
  officeAddress: string;
  /** Style choice that guides wording without changing the underlying form fields. */
  tone: 'grateful' | 'professional' | 'direct';
}