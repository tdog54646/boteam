import { useLanguage } from "./preferences";
import React, { useState } from "react";
import { Discovery } from "./Accounts";
import { BotForm } from "./Bots";
import { Button } from "./ui";
import "./settings.css";

export function Onboarding({ state, invoke, refresh, finishWizard, busy }) {
  const tr = useLanguage();
  const [step, setStep] = useState(1);
  const [defaultAccount, setDefaultAccount] = useState("");
  async function finishImport(ids) {
    await refresh();
    setDefaultAccount(ids[0]);
    setStep(2);
  }
  return (
    <div className="page-scroll">
      <div className="setup-page">
        <section className="setup-content" aria-labelledby="setup-title">
          <header className="setup-heading">
            <ol className="setup-progress" aria-label={tr("初始设置进度", "Setup progress")}>
              <li aria-current={step === 1 ? "step" : undefined}>{tr("导入账号", "Import accounts")}</li>
              <li aria-current={step === 2 ? "step" : undefined}>{tr("创建 Bot", "Create bot")}</li>
            </ol>
            <h1 id="setup-title">
              {step === 1 ? tr("导入本机账号", "Import local accounts") : tr("创建第一个 Bot", "Create your first bot")}
            </h1>
            <p>
              {step === 1
                ? tr("选择已登录的工具账号，让 Bot 使用你的订阅。", "Choose a signed-in CLI account for your bot to use.")
                : tr("给 Bot 起个名字，选择它使用的订阅账号。", "Give your bot a name and choose its subscription account.")}
            </p>
          </header>
          {step === 1 ? (
            <Discovery
              invoke={invoke}
              onboarding
              pending={busy}
              onFinish={finishImport}
              onSkip={() => finishWizard()}
            />
          ) : state.accounts.length ? (
            <BotForm
              accounts={state.accounts}
              defaultAccountId={defaultAccount}
              invoke={invoke}
              onDone={finishWizard}
              onCancel={() => finishWizard()}
              onboarding
              pending={busy}
            />
          ) : (
            <>
              <p className="plain-note">
                {tr("还没有可绑定的账号。可以重新检测，或稍后在账号管理中添加。", "No accounts available yet. Scan again or add one in Settings later.")}
              </p>
              <div className="setup-footer">
                <Button disabled={busy} onClick={() => setStep(1)}>
                  {tr("返回检测", "Back to scan")}
                </Button>
                <Button
                  variant="primary"
                  busy={busy}
                  onClick={() => finishWizard()}
                >
                  {tr("进入工作台", "Open workspace")}
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
