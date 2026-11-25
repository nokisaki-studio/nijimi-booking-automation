# 水彩教室にじみ 体験予約の自動受付(見本)

架空の水彩教室「にじみ」の [体験申し込み LP](https://nokisaki-studio.github.io/nijimi-lp-sample/) で受けた申込を、Google スプレッドシートと Apps Script で自動で回す見本です。Nokisaki Studio の出品「毎日の作業の自動化」の制作サンプルとして作りました。教室・講師・申込はすべて架空です。

- 動く見本: https://nokisaki-studio.github.io/nijimi-booking-automation/ (ブラウザの中だけで動きます。メールは送られません)
- Apps Script 版: `core.js` と `gas/Code.gs`

## 何をするか

| いつ | すること |
|---|---|
| 申込が届いたとき | 「申込」のシートに 1 行足す。申込者へ受付メール、講師へ知らせ。希望の時間帯で、申込から 24 時間以上あとの、空きがあり休講日でない、いちばん近い回を候補にする(1 回の定員 5 人。在籍の生徒さんも数える)。同じメールアドレスの申込が残っていれば「重複」にまとめ、受付メールは送らない |
| 講師が「確定」にチェックを入れたとき | 申込者へ、日時・場所・持ち物の案内メール。人が決めるのはここだけ |
| 毎朝 9 時台 | 受付から 1 日たっても確定していない申込を講師に知らせる(1 日 1 回)。明日が体験の方へ前日のお知らせ(1 回だけ) |
| 毎週月曜 8 時台 | 先週(月〜日)の申込の数・時間帯ごとの数・見学のご希望・確定までの平均時間を「週報」のシートに書き、講師へ送る |

そのほか: 見えない入力欄に値が入った申込はボットとして記録だけし、返信しない。式として読まれる文字(`=` などで始まる名前)は文字のまま記録する。メールを送れなかったときは表に「未送信」と書いて講師に知らせる。日時はすべて日本時間で数える。

## ファイル

| ファイル | 中身 |
|---|---|
| `core.js` | 処理の中身。候補の回・定員・休講日・重複・メールの文面・週のまとめ。Google のサービスを呼ばないので、見本のページ・Apps Script・Node のテストで同じものを使う |
| `gas/Code.gs` | Apps Script 版。`setup`(シートとトリガーを作る)・`doPost`(LP のフォームから受ける)・`onSheetEdit`(確定)・`dailyRun`・`weeklyRun`。先頭の `SETTINGS` だけ書き換える |
| `gas/appsscript.json` | 時間帯(Asia/Tokyo)と V8 ランタイム |
| `index.html`・`styles.css`・`demo.js` | 動く見本のページ。`core.js` をそのまま使う |
| `test/` | Node のテスト(ライブラリなし)。`core.test.js` は処理の中身、`gas.test.js` は Google のサービスを偽物(`fake-gas.js`)に置き換えて Apps Script 版の流れを確かめる |

## テスト

```
node --test test/*.test.js
```

33 件。日本以外の時間帯の機械でも同じ結果になることを、`TZ=America/Los_Angeles` でも確かめています。

## Apps Script に入れる(本物で動かす)

1. Google スプレッドシートを新しく作り、「拡張機能 → Apps Script」を開く
2. `Code.gs` の中身を、このリポジトリの `gas/Code.gs` に置き換える
3. ファイルを足して(「+」→ スクリプト)名前を `core` にし、`core.js` の中身を貼る
4. 「プロジェクトの設定」で「appsscript.json マニフェスト ファイルをエディタで表示する」をオンにし、`gas/appsscript.json` の中身にする
5. `setup` を選んで実行し、表示に従って権限を許可する(シート 4 つとトリガー 3 つができる)
6. 「デプロイ → 新しいデプロイ → ウェブアプリ」で、実行するユーザーを自分、アクセスできるユーザーを全員にしてデプロイし、表示された URL を控える
7. LP のフォームから、その URL へ送る(例: `fetch(URL, { method: 'POST', body: new URLSearchParams(new FormData(form)) })`。項目名は `name`・`email`・`time`・`message`・`website`)

メールは、このスクリプトを動かすアカウントから送られます。無料の Gmail のアカウントでは 1 日 100 人までです(Google の [割り当て](https://developers.google.com/apps-script/guides/services/quotas))。

## 確かめたこと・まだのこと

- 確かめた: Node のテスト 33 件(Apps Script のサービスは偽物)。見本のページは PC とスマホで動かした
- まだ: Google のアカウント上での実行。特に、LP のような別のサイトからウェブアプリへ送るところは、本物で確かめていない

## やらないこと

支払い、LINE への通知、Google カレンダーとの連携、Google フォーム版、会員の管理。

---

下書きとコードに AI ツールを使い、仕上げの確認はすべて自分で行っています。制作 Nokisaki Studio。
