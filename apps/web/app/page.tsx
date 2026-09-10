'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SecurityReport } from '@storefront/shared';
import { apiGet } from '../lib/api';
import { LAYERS } from './security/layers';
import { DemoButton } from './demo-button';
import { readCached, writeCached } from '../lib/cache';

/**
 * The landing page.
 *
 * The headline is the smallest honest transaction in the system: someone asks
 * an agent to buy them a chai. Everything below it is the argument for why that
 * sentence is hard to make safe, and the figures near the bottom are read off
 * the real attack report rather than written into the copy — if the API is down
 * the band goes away rather than showing a number nobody ran.
 */
export default function Landing() {
  const [report, setReport] = useState<SecurityReport | null>(null);

  useEffect(() => {
    const cached = readCached<SecurityReport>('security-report');
    if (cached) setReport(cached);
    void apiGet<SecurityReport>('/security/report')
      .then((fresh) => { setReport(fresh); writeCached('security-report', fresh); })
      .catch(() => undefined);
  }, []);

  return (
    <main className="landing" id="main">
      <section className="hero">
        <div className="wrap hero-grid">
          <div>
            {/* <p className="eyebrow">Agentic Commerce Hub</p> */}
            <h1>Agent, Buy me a chai.</h1>
            <p className="hero-lede">
              Four words, one agent, and your card. AchPay is the layer in between — it decides what
              the agent may spend, refuses everything else, and writes down why.
            </p>
            <div className="hero-actions">
              <DemoButton />
              <Link className="button button--secondary" href="/merchant/login">
                Register as Merchant
              </Link>
            </div>
            <p className="hero-note">
              Every amount below is an integer number of paise. No floating-point number touches
              money anywhere in this system.
            </p>
          </div>

          <div className="receipt">
            <div className="receipt-head">
              <h2>Example intent</h2>
              <span className="chip dim mono">quote_id</span>
            </div>
            <dl>
              <div className="receipt-line">
                <dt>Masala chai, 250ml</dt>
                <dd>4000 paise</dd>
              </div>
              <div className="receipt-line">
                <dt>Priced by</dt>
                <dd>catalog, not the agent</dd>
              </div>
              <div className="receipt-line">
                <dt>Mandate headroom</dt>
                <dd>50000 paise</dd>
              </div>
              <div className="receipt-line">
                <dt>Rule</dt>
                <dd>allow.under_cap</dd>
              </div>
            </dl>
            <div className="receipt-total">
              <span className="eyebrow">Charged</span>
              <span>₹40.00</span>
            </div>
            <p className="receipt-verdict">
              <span className="live-dot" aria-hidden="true" />
              Allowed, charged once, and written to the chain.
            </p>
          </div>
        </div>
      </section>

      <section className="section-band">
        <div className="wrap">
          <div className="longform">
          <p className="eyebrow">The problem</p>
          <h2>An agent with a card is a stranger with your card.</h2>
          <p>
            The moment a model can spend, every sentence it reads becomes a possible instruction. A
            product description can ask for a discount. A retry can become a second charge. A
            helpful assistant, asked politely enough, will find the cheapest way to say yes.
          </p>
          <p>
            The usual answer is to make the model more careful. That is a hope, not a control. AchPay
            takes the decision away from the model entirely: the agent never names a price, never
            names an amount, and never gets to argue with the rule that stopped it.
          </p>
          <blockquote className="pull-quote">
            The only handle an agent has on money is a quote_id it did not write.
          </blockquote>
          </div>
        </div>
      </section>

      <section className="section-band">
        <div className="wrap">
          <div className="longform">
            <p className="eyebrow">How it works</p>
            <h2>Six layers, in the order a purchase moves through them.</h2>
          </div>
          <ol className="layer-list">
            {LAYERS.map((layer) => (
              <li key={layer.id}>
                <h3>{layer.title}</h3>
                <p>{layer.claim}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {report !== null && (
        <section className="section-band band--inverse">
          <div className="wrap">
            <div className="longform">
              <p className="eyebrow">Evidence</p>
              <h2>Twenty attacks, and the grid that ran them.</h2>
              <p>
                These figures come from the last run of the adversarial suite, not from the copy on
                this page. The open ones stay on the board — a grid that only shows passes is a
                slide, not a result.
              </p>
            </div>
            <div className="figures">
              <div className="figure">
                <div className="figure-value">{report.held}</div>
                <div className="figure-label">attacks held, of {report.total} run</div>
              </div>
              <div className="figure">
                <div className="figure-value">{report.total - report.held}</div>
                <div className="figure-label">still open, and still listed</div>
              </div>
              <div className="figure">
                <div className="figure-value">{report.ledger_chain.rows_checked}</div>
                <div className="figure-label">
                  ledger rows {report.ledger_chain.ok ? 'verified against the chain' : 'checked'}
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="closing">
        <div className="wrap">
          <h2>Give the agent a wallet it cannot misuse.</h2>
          <p>
            Every decision names the rule that made it, including the ones that said yes. Start with
            the attacks, then read the rows they wrote.
          </p>
          <div className="hero-actions hero-actions--center">
            <DemoButton />
            <Link className="button button--secondary" href="/lab">
              Agent Lab
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
