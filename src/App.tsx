import { useState, useEffect } from 'react';
import { supabase, type ResignationLetter, type LetterFormData } from '@/lib/supabase';
import { FileText, Briefcase, Calendar, User, MessageSquare, Sparkles, Copy, Download, Check, ArrowRight, Shield, RotateCcw, Loader2 } from 'lucide-react';

type Step = 'form' | 'processing' | 'output';
type Tone = 'grateful' | 'professional' | 'direct';

const TONES: { value: Tone; label: string; description: string }[] = [
  { value: 'grateful', label: 'Grateful', description: 'Warm and appreciative' },
  { value: 'professional', label: 'Professional', description: 'Formal and neutral' },
  { value: 'direct', label: 'Direct', description: 'Straight to the point' },
];

const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

export default function App() {
  const [step, setStep] = useState<Step>('form');
  const [formData, setFormData] = useState<LetterFormData>({
    managerName: '',
    company: '',
    lastDay: '',
    reason: '',
    tone: 'professional',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [letter, setLetter] = useState<string | null>(null);
  const [letterId, setLetterId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    const returnedLetterId = params.get('letter_id');
    const cancelled = params.get('cancelled');

    if (cancelled) {
      window.history.replaceState({}, document.title, window.location.pathname);
      return;
    }

    if (sessionId && returnedLetterId) {
      handlePostPayment(returnedLetterId);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  async function handlePostPayment(id: string) {
    setStep('processing');
    setError(null);
    try {
      const { data: record, error: dbError } = await supabase
        .from('resignation_letters')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (dbError || !record) {
        setError('Could not retrieve your letter. Please contact support.');
        setStep('form');
        return;
      }

      const letterRecord = record as ResignationLetter;

      await supabase
        .from('resignation_letters')
        .update({ paid: true })
        .eq('id', id);

      if (letterRecord.letter_text) {
        setLetter(letterRecord.letter_text);
        setLetterId(id);
        setStep('output');
      } else {
        const generated = await generateLetter(id, letterRecord);
        if (generated) {
          setLetter(generated);
          setLetterId(id);
          setStep('output');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      setStep('form');
    }
  }

  async function generateLetter(id: string, record: ResignationLetter): Promise<string | null> {
    const response = await fetch(`${FUNCTION_URL}/generate-letter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        letterId: id,
        managerName: record.manager_name,
        company: record.company,
        lastDay: record.last_day,
        reason: record.reason,
        tone: record.tone,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'Letter generation failed');
    }

    const data = await response.json();
    if (!data.letter) {
      throw new Error('No letter content returned');
    }

    return data.letter as string;
  }

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    if (!formData.managerName.trim()) newErrors.managerName = 'Required';
    if (!formData.company.trim()) newErrors.company = 'Required';
    if (!formData.lastDay.trim()) newErrors.lastDay = 'Required';
    if (!waiverAccepted) newErrors.waiver = 'You must accept the disclaimer to continue';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    setError(null);

    try {
      const { data, error: insertError } = await supabase
        .from('resignation_letters')
        .insert({
          manager_name: formData.managerName,
          company: formData.company,
          last_day: formData.lastDay,
          reason: formData.reason || null,
          tone: formData.tone,
          paid: false,
        })
        .select()
        .single();

      if (insertError || !data) {
        setError('Failed to save your details. Please try again.');
        setLoading(false);
        return;
      }

      const record = data as ResignationLetter;
      const newLetterId = record.id;
      setLetterId(newLetterId);

      const response = await fetch(`${FUNCTION_URL}/create-checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          letterId: newLetterId,
          formData,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Payment setup failed');
      }

      const checkoutData = await response.json();
      if (checkoutData.url) {
        window.location.href = checkoutData.url;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      setLoading(false);
    }
  }

  function handleCopy() {
    if (!letter) return;
    navigator.clipboard.writeText(letter);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownload() {
    if (!letter) return;
    const blob = new Blob([letter], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'resignation-letter.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleReset() {
    setStep('form');
    setLetter(null);
    setLetterId(null);
    setFormData({
      managerName: '',
      company: '',
      lastDay: '',
      reason: '',
      tone: 'professional',
    });
    setWaiverAccepted(false);
    setErrors({});
    setError(null);
  }

  if (step === 'processing') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center px-4">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-slate-700 mx-auto mb-4 animate-spin" />
          <h2 className="text-xl font-semibold text-slate-800">Generating your letter...</h2>
          <p className="text-slate-500 mt-2">This will only take a moment.</p>
        </div>
      </div>
    );
  }

  if (step === 'output') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 py-12 px-4">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 bg-emerald-50 text-emerald-700 px-4 py-2 rounded-full text-sm font-medium mb-4">
              <Check className="w-4 h-4" />
              Letter Generated Successfully
            </div>
            <h1 className="text-3xl font-bold text-slate-900">Your Resignation Letter</h1>
            <p className="text-slate-500 mt-2">Review, copy, or download your professional resignation letter below.</p>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="bg-slate-50 border-b border-slate-200 px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-600 text-sm font-medium">
                <FileText className="w-4 h-4" />
                Resignation Letter
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  onClick={handleDownload}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download
                </button>
              </div>
            </div>
            <div className="p-6">
              <pre className="whitespace-pre-wrap font-serif text-slate-800 text-base leading-relaxed">
                {letter}
              </pre>
            </div>
          </div>

          <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={handleReset}
              className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-white border border-slate-300 text-slate-700 font-medium rounded-xl hover:bg-slate-50 transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              Create Another Letter
            </button>
          </div>

          <p className="text-center text-xs text-slate-400 mt-8 max-w-md mx-auto leading-relaxed">
            This letter was generated by AI and is provided for informational purposes only.
            It does not constitute legal advice. Please review and edit before sending.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100">
      <div className="min-h-screen flex flex-col">
        <header className="border-b border-slate-200/60 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
          <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 bg-slate-900 rounded-lg flex items-center justify-center">
                <FileText className="w-5 h-5 text-white" />
              </div>
              <span className="font-semibold text-slate-900 text-lg">ResignLetter</span>
            </div>
            <span className="text-sm text-slate-500 hidden sm:block">AI Resignation Letter Generator</span>
          </div>
        </header>

        <main className="flex-1 flex items-center justify-center px-4 py-12">
          <div className="w-full max-w-xl">
            <div className="text-center mb-8">
              <div className="inline-flex items-center gap-2 bg-slate-100 text-slate-600 px-4 py-2 rounded-full text-sm font-medium mb-4">
                <Sparkles className="w-4 h-4" />
                AI-Powered · Ready in seconds
              </div>
              <h1 className="text-4xl font-bold text-slate-900 tracking-tight">
                Write Your Resignation Letter
              </h1>
              <p className="text-slate-500 mt-3 text-lg">
                Professional, clean, and respectful. No bridges burned.
              </p>
            </div>

            {error && (
              <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 sm:p-8 space-y-6">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Manager's Name
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={formData.managerName}
                    onChange={(e) => setFormData({ ...formData, managerName: e.target.value })}
                    placeholder="e.g. Sarah Johnson"
                    className="w-full pl-10 pr-4 py-3 border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent transition-all"
                  />
                </div>
                {errors.managerName && <p className="text-red-500 text-xs mt-1">{errors.managerName}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Company Name
                </label>
                <div className="relative">
                  <Briefcase className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={formData.company}
                    onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                    placeholder="e.g. Acme Corporation"
                    className="w-full pl-10 pr-4 py-3 border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent transition-all"
                  />
                </div>
                {errors.company && <p className="text-red-500 text-xs mt-1">{errors.company}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Last Working Day
                </label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="date"
                    value={formData.lastDay}
                    onChange={(e) => setFormData({ ...formData, lastDay: e.target.value })}
                    className="w-full pl-10 pr-4 py-3 border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent transition-all"
                  />
                </div>
                {errors.lastDay && <p className="text-red-500 text-xs mt-1">{errors.lastDay}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Reason <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <div className="relative">
                  <MessageSquare className="absolute left-3 top-4 w-4 h-4 text-slate-400" />
                  <textarea
                    value={formData.reason}
                    onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                    placeholder="e.g. New career opportunity, relocation, personal reasons..."
                    rows={3}
                    className="w-full pl-10 pr-4 py-3 border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent transition-all resize-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-3">
                  Tone
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {TONES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setFormData({ ...formData, tone: t.value })}
                      className={`px-3 py-3 rounded-xl border text-sm font-medium transition-all text-center ${
                        formData.tone === t.value
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      <div className="font-semibold">{t.label}</div>
                      <div className={`text-xs mt-0.5 ${formData.tone === t.value ? 'text-slate-300' : 'text-slate-400'}`}>
                        {t.description}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={waiverAccepted}
                    onChange={(e) => setWaiverAccepted(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                  />
                  <span className="text-xs text-slate-600 leading-relaxed">
                    I understand this letter is AI-generated and does not constitute legal advice.
                    I am responsible for reviewing and editing the letter before sending it to my employer.
                  </span>
                </label>
                {errors.waiver && <p className="text-red-500 text-xs mt-2">{errors.waiver}</p>}
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-slate-900 text-white font-semibold py-4 rounded-xl hover:bg-slate-800 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Redirecting to payment...
                  </>
                ) : (
                  <>
                    Generate Letter — £1
                    <ArrowRight className="w-5 h-5" />
                  </>
                )}
              </button>

              <div className="flex items-center justify-center gap-2 text-xs text-slate-400">
                <Shield className="w-3.5 h-3.5" />
                Secure payment via Stripe
              </div>
            </form>

            <div className="mt-8 grid grid-cols-3 gap-4 text-center">
              <div className="px-2">
                <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-2">
                  <span className="text-sm font-bold text-slate-600">1</span>
                </div>
                <p className="text-xs text-slate-500">Fill in details</p>
              </div>
              <div className="px-2">
                <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-2">
                  <span className="text-sm font-bold text-slate-600">2</span>
                </div>
                <p className="text-xs text-slate-500">Pay £1 securely</p>
              </div>
              <div className="px-2">
                <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-2">
                  <span className="text-sm font-bold text-slate-600">3</span>
                </div>
                <p className="text-xs text-slate-500">Get your letter</p>
              </div>
            </div>
          </div>
        </main>

        <footer className="border-t border-slate-200/60 bg-white/80">
          <div className="max-w-3xl mx-auto px-4 py-6 text-center">
            <p className="text-xs text-slate-400">
              ResignLetter — AI-generated resignation letters. Not legal advice.
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
