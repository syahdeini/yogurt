import { useState } from 'react'
import { t } from '../../../shared/i18n'
import type { CloudStatus } from '../../../shared/types'
import wordmarkUrl from '../assets/wordmark.png'

/** The only screen in cloud mode until a Preferred by Nature account is signed in. */
export function CloudSignIn({ status }: { status: CloudStatus }) {
  const [busy, setBusy] = useState(false)
  const signIn = () => {
    setBusy(true)
    void window.yogurt.cloud.signIn().finally(() => setBusy(false))
  }
  const message = status.error === 'wrong-org' ? t('Only Preferred by Nature accounts can use PBN Whisper.')
    : status.error === 'keychain' ? t("PBN Whisper couldn't use the system keychain to keep you signed in.")
    : status.error === 'not-configured' ? t('Add the cloud tenant, client and API address first.')
    : status.error === 'failed' ? t("Sign-in didn't finish. Try again.")
    : ''
  return (
    <div data-testid="cloud-sign-in" className="flex h-full flex-col items-center justify-center gap-8 bg-bg px-8 text-center">
      <img src={wordmarkUrl} alt="PBN Whisper" className="h-20 w-auto max-w-[min(440px,80vw)]" draggable={false} />
      <button type="button" data-testid="cloud-sign-in-button" disabled={busy} onClick={signIn} className="modal-button primary" style={{ width: 'auto', minHeight: 40, padding: '8px 18px', fontSize: 14 }}>
        {t('Sign in with your Preferred by Nature account')}
      </button>
      {message && <p data-testid="cloud-sign-in-error" className="max-w-sm text-sm text-ink">{message}</p>}
    </div>
  )
}
