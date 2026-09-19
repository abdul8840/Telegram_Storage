/** Public privacy and Telegram-connection disclosure. */
import { Link } from 'react-router-dom';
import { ArrowLeft, Cloud, Database, KeyRound, ShieldCheck } from 'lucide-react';

const sections = [
  {
    icon: KeyRound,
    title: 'Credentials and authorization',
    body: (
      <>
        Your ZoZoCloud account password is stored only as a one-way bcrypt hash. When you connect Telegram, the API
        ID, API hash, phone number, login code and—when enabled—two-step verification password are sent over HTTPS to
        this server. The code and two-step password are used transiently to complete Telegram sign-in and are not
        stored. The resulting MTProto session and API hash are encrypted at rest.
      </>
    ),
  },
  {
    icon: Cloud,
    title: 'Where files go',
    body: (
      <>
        File payloads are uploaded to the Telegram Saved Messages, channel or chat selected by the server operator.
        ZoZoCloud keeps file and folder metadata in its database. Upload chunks and media-processing files exist
        temporarily on the application server and are removed when processing finishes. Generated thumbnails may
        remain there as a cache until their file is deleted; the original file payload is kept in Telegram.
      </>
    ),
  },
  {
    icon: Database,
    title: 'Who operates this service',
    body: (
      <>
        ZoZoCloud is independent software and is not affiliated with, sponsored by or endorsed by Telegram. The person
        operating this deployment controls its server, database, encryption keys and logs. Only connect an account to
        a deployment you trust. You can revoke active sessions at any time from Telegram’s Devices settings.
      </>
    ),
  },
];

export function PrivacyPage() {
  return (
    <div className="public-page">
      <main className="public-card" style={{ maxWidth: 820 }}>
        <header className="public-head">
          <span className="brand-mark"><Cloud /></span>
          <div>
            <div className="brand-name">ZoZoCloud</div>
            <div className="brand-sub">Privacy and connection details</div>
          </div>
          <span className="grow" />
          <Link className="btn btn-ghost btn-sm" to="/login"><ArrowLeft /> Back</Link>
        </header>

        <div className="panel-pad" style={{ display: 'grid', gap: 16 }}>
          <div className="callout callout-brand">
            <ShieldCheck />
            <div>
              <div className="callout-title">Connect only after reviewing these details</div>
              <p className="small" style={{ marginTop: 4 }}>
                ZoZoCloud needs access to your Telegram account only because Telegram is the configured file-storage
                backend. It never asks for a Telegram credential merely to create or sign in to a ZoZoCloud account.
              </p>
            </div>
          </div>

          {sections.map(({ icon: Icon, title, body }) => (
            <section className="panel" key={title}>
              <div className="panel-pad">
                <h2 className="panel-title"><Icon /> {title}</h2>
                <p className="page-sub" style={{ marginTop: 10, lineHeight: 1.7 }}>{body}</p>
              </div>
            </section>
          ))}

          <p className="tiny faint" style={{ lineHeight: 1.6 }}>
            This page describes the bundled application. A public deployment’s operator should publish their identity,
            contact details and any additional retention policy that applies to their hosting environment.
          </p>
        </div>
      </main>
    </div>
  );
}

export default PrivacyPage;
