export interface LetterFormData {
  senderName: string;
  managerName: string;
  company: string;
  lastDay: string;
  reason: string;
  homeAddress: string;
  officeAddress: string;
  tone: 'grateful' | 'professional' | 'direct';
}