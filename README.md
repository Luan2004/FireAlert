# Flask + Automate SMS/call setup

This setup does not need a public backend host when the PC and Android phone are on the same Wi-Fi/LAN.

Flow:

```text
fire.html / fire.js
  -> POST http://<PC-IP>:8765/alert-state when fire starts, level increases, or fire ends
  -> Flask stores only the current active fire state
  -> SMS Automate flow polls http://<PC-IP>:8765/automate/next-sms
  -> Call Automate flow polls http://<PC-IP>:8765/automate/next-call
  -> Call flow posts call result to http://<PC-IP>:8765/automate/call-result
```
<img width="1920" height="877" alt="image" src="https://github.com/user-attachments/assets/924e6261-f497-48f1-8448-52cc58406016" />


## 1. Install Flask on the PC

Open PowerShell in this folder:

```powershell
cd D:\Downloads\HestAI\fireAlert
python -m pip install -r requirements.txt
```

## 2. Start the Flask bridge

Run:

```powershell
python automate_bridge.py
```

Or double click:

```text
run_automate_bridge.bat
```

The server runs on:

```text
http://0.0.0.0:8765
```

Find your PC LAN IP:

```powershell
ipconfig
```

Look for the Wi-Fi IPv4 address, for example:

```text
192.168.1.10
```

Open the fire alert web app with:

```text
http://192.168.1.10:8765/
```

If Windows Firewall asks, allow Python/Flask on Private networks.

Use the gear button in the web sidebar to set the call retry delay. The browser saves it locally and sends it to the Flask bridge.

Alert rules:

```text
New fire alert:
  SMS: "Cảnh báo cháy cấp độ ... tại camera ..."
  Call: call immediately

Fire level increases:
  SMS: "Cảnh báo cháy: Cấp độ cháy tăng lên cấp độ ... tại camera ..."
  Call: keep following the current call retry timing

Fire ends:
  Stop repeat calls for that alert
```

## 3. Test the bridge from browser

Open this on the phone browser while connected to the same Wi-Fi:

```text
http://192.168.1.10:8765/health
```

You should see JSON with:

```json
{"ok": true}
```

## 4. Configure Automate on Android

Install Automate by LlamaLab, then create two flows.

### Flow 1: SMS realtime

1. Flow beginning
2. HTTP request
3. Expression true?
4. SMS send
5. Delay
6. Connect Delay back to HTTP request

#### SMS HTTP request block

Method:

```text
GET
```

URL:

```text
http://192.168.1.10:8765/automate/next-sms
```

Save response body to variable:

```text
body
```

#### SMS Expression true? block

Expression:

```text
body = "0"
```

YES path goes to Delay.

NO path goes to SMS send.

#### SMS send block

Phone number:

```text
0896465996
```

Message:

```text
body
```

After SMS send, connect OK to Delay.

#### SMS Delay block

Duration:

```text
3s
```

Connect Delay back to the SMS HTTP request.

### Flow 2: Call realtime

1. Flow beginning
2. HTTP request
3. JSON decode
4. Expression true?
5. Phone call / Call number
6. HTTP request for call result
7. Delay
8. Connect Delay back to HTTP request

#### Call HTTP request block

Method:

```text
GET
```

URL:

```text
http://192.168.1.10:8765/automate/next-call-json
```

Save response body to variable:

```text
body
```

#### Call JSON decode block

Input:

```text
body
```

Output variable:

```text
data
```

#### Call Expression true? block

Expression:

```text
data["has_alert"] = true
```

YES path goes to Phone call / Call number.

NO path goes to Delay.

#### Phone call / Call number block

Phone number:

```text
data["phone"]
```

After the call block, connect OK to Delay.

For missed/rejected calls, connect the failure/no-answer path to the same call-result request below.

#### Call result HTTP request block

Add this block after the phone call block so the PC knows when it may call again.

Method:

```text
POST
```

URL:

```text
http://192.168.1.10:8765/automate/call-result
```

Content type:

```text
application/json
```

Request content:

```text
{"alert_id":data["alert_id"],"status":"ended"}
```

If your Automate call block can branch by result, use `"answered"` when the call is accepted and `"missed"` or `"rejected"` when it is not. Missed/rejected calls are delayed by the value set on the web settings button, then called again only if the fire alert is still active.

If Automate asks for SMS/phone permission, allow it.

#### Call Delay block

Duration:

```text
3s
```

Connect Delay back to the Call HTTP request.

## 5. Text endpoints for flows like the screenshot

SMS flow URL:

```text
http://192.168.1.10:8765/automate/next-sms-text
```

It returns:

```text
0
```

when there is no SMS alert, or the exact SMS message when there is an alert. Use `body` directly as the SMS message.

Call flow URL:

```text
http://192.168.1.10:8765/automate/next-call
```

It returns `0` when there is no call task, or:

```text
1;0896465996;Canh bao...;log-cam-1-123
```

when there is a task. The full format is:

```text
1;phone;message;alert_id
```

Split the body by `;`. Use the second part as phone, third part as message, and fourth part as `alert_id` when the call flow posts `/automate/call-result`.

For the text-style call flow, you can report a missed call with a GET request:

```text
http://192.168.1.10:8765/automate/call-result-text?alert_id=<alert_id>&status=missed
```

Use `status=answered` when the call is accepted. Use `status=missed`, `rejected`, or `ended` when the call was not answered.

## 6. Optional token

For LAN testing, token can be empty.

If you want a simple token, start Flask with:

```powershell
$env:AUTOMATE_TOKEN="123456"
python automate_bridge.py
```

Then use this Automate URL:

```text
http://192.168.1.10:8765/automate/next-sms?token=123456
http://192.168.1.10:8765/automate/next-call?token=123456
```

For the text endpoint:

```text
http://192.168.1.10:8765/automate/next-sms-text?token=123456
http://192.168.1.10:8765/automate/next-call-text?token=123456
http://192.168.1.10:8765/automate/call-result-text?token=123456&alert_id=<alert_id>&status=missed
```

## Troubleshooting

- Phone cannot open `/health`: check same Wi-Fi, PC IP, Windows Firewall, and Flask host is `0.0.0.0`.
- Web shows Automate realtime status but phone does nothing: check Automate flow is running and the HTTP request URL uses the PC IP, not `127.0.0.1`.
- Automate gets `has_alert=false`: trigger a new fire alert from the web, then wait up to the Delay interval.
- SMS block fails: check Android SMS permission, default SIM, phone balance, and Android battery optimization for Automate.
- Call block fails: check Phone permission and Android default dialer permission.
