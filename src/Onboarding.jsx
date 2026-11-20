import React, { useState } from "react";
import { Discovery } from "./Accounts";
import { BotForm } from "./Bots";
import { Button } from "./ui";
import "./settings.css";

export function Onboarding({ state, invoke, refresh, finishWizard, busy }) {
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
            <ol className="setup-progress" aria-label="初始设置进度">
              <li aria-current={step === 1 ? "step" : undefined}>导入账号</li>
              <li aria-current={step === 2 ? "step" : undefined}>创建 Bot</li>
            </ol>
            <h1 id="setup-title">
              {step === 1 ? "导入本机账号" : "创建第一个 Bot"}
            </h1>
            <p>
              {step === 1
                ? "选择已登录的工具账号，让 Bot 使用你的订阅。"
                : "给 Bot 起个名字，选择它使用的订阅账号。"}
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
                还没有可绑定的账号。可以重新检测，或稍后在账号管理中添加。
              </p>
              <div className="setup-footer">
                <Button disabled={busy} onClick={() => setStep(1)}>
                  返回检测
                </Button>
                <Button
                  variant="primary"
                  busy={busy}
                  onClick={() => finishWizard()}
                >
                  进入工作台
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
