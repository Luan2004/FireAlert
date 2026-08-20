import hashlib
import io
import os
import re
import secrets
import sys
import time
import json
from threading import Lock, Thread

from flask import Flask, Response, jsonify, request, send_from_directory

try:
    import cv2
except Exception as exc:
    cv2 = None
    CV2_IMPORT_ERROR = str(exc)
else:
    CV2_IMPORT_ERROR = ""

try:
    from PIL import Image
except Exception as exc:
    Image = None
    IMAGE_IMPORT_ERROR = str(exc)
else:
    IMAGE_IMPORT_ERROR = ""

try:
    import psutil
except Exception as exc:
    psutil = None
    PSUTIL_IMPORT_ERROR = str(exc)
else:
    PSUTIL_IMPORT_ERROR = ""

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
LOCAL_MODEL_PATH = os.environ.get("FIRE_ALERT_LOCAL_MODEL", os.path.join(BASE_DIR, "y8ndfire.pt"))
local_model = None
local_model_error = None
local_model_lock = Lock()
LOCAL_RTSP_OPEN_TIMEOUT_MS = int(os.environ.get("FIRE_ALERT_RTSP_OPEN_TIMEOUT_MS", "5000"))
LOCAL_RTSP_READ_TIMEOUT_MS = int(os.environ.get("FIRE_ALERT_RTSP_READ_TIMEOUT_MS", "5000"))
LOCAL_RTSP_JPEG_QUALITY = int(os.environ.get("FIRE_ALERT_RTSP_JPEG_QUALITY", "80"))
LOCAL_RTSP_PREVIEW_FPS = float(os.environ.get("FIRE_ALERT_RTSP_PREVIEW_FPS", "12"))
LOCAL_RTSP_PREVIEW_MAX_HEIGHT = int(os.environ.get("FIRE_ALERT_RTSP_PREVIEW_MAX_HEIGHT", "720"))
LOCAL_RTSP_TRANSPORT = os.environ.get("FIRE_ALERT_RTSP_TRANSPORT", "tcp").strip().lower()
LOCAL_RTSP_LOW_LATENCY = os.environ.get("FIRE_ALERT_RTSP_LOW_LATENCY", "true").strip().lower() not in {"0", "false", "no"}
LOCAL_CLASS_NAMES = [
    name.strip()
    for name in os.environ.get("FIRE_ALERT_LOCAL_CLASS_NAMES", "fire,other,smoke").split(",")
    if name.strip()
]

def load_config():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def save_config(config_data):
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(config_data, f, ensure_ascii=False, indent=2)  
    except Exception:
        pass


def get_local_model():
    global local_model, local_model_error

    if local_model is not None:
        return local_model
    if local_model_error:
        raise RuntimeError(local_model_error)

    with local_model_lock:
        if local_model is not None:
            return local_model
        if local_model_error:
            raise RuntimeError(local_model_error)
        if not os.path.exists(LOCAL_MODEL_PATH):
            local_model_error = f"Local model not found: {LOCAL_MODEL_PATH}"
            raise RuntimeError(local_model_error)

        try:
            from ultralytics import YOLO

            local_model = YOLO(LOCAL_MODEL_PATH)
            return local_model
        except Exception as exc:
            local_model_error = str(exc)
            raise


def local_model_status():
    available = os.path.exists(LOCAL_MODEL_PATH)
    return {
        "available": available and not bool(local_model_error) and Image is not None,
        "loaded": local_model is not None,
        "path": LOCAL_MODEL_PATH,
        "error": local_model_error or IMAGE_IMPORT_ERROR,
        "class_names": LOCAL_CLASS_NAMES,
    }


def local_class_name(cls_id, names):
    if 0 <= cls_id < len(LOCAL_CLASS_NAMES):
        return LOCAL_CLASS_NAMES[cls_id]
    return str(names.get(cls_id, cls_id))


def run_local_detection(image_bytes, conf=0.5, imgsz=640):
    if Image is None:
        raise RuntimeError(f"Pillow is not installed: {IMAGE_IMPORT_ERROR}")
    model = get_local_model()
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    width, height = image.size
    results = model.predict(image, conf=conf, imgsz=imgsz, verbose=False)
    result = results[0] if results else None
    annotations = []

    if result is not None and result.boxes is not None:
        names = getattr(result, "names", {}) or getattr(model, "names", {}) or {}
        for box in result.boxes:
            xyxy = box.xyxy[0].tolist()
            score = float(box.conf[0]) if box.conf is not None else 0.0
            cls_id = int(box.cls[0]) if box.cls is not None else -1
            name = local_class_name(cls_id, names)
            if "other" in name.lower():
                continue
            x1, y1, x2, y2 = [float(v) for v in xyxy]
            annotations.append({
                "category_name": name,
                "score": score,
                "bbox": [x1, y1, max(0.0, x2 - x1), max(0.0, y2 - y1)],
            })

    return {
        "type": "detections",
        "annotations": annotations,
        "image_shape": [height, width],
    }


def clamp_int(value, default_value, min_value, max_value):
    try:
        value = int(value)
    except Exception:
        value = default_value
    return max(min_value, min(value, max_value))


def clamp_float(value, default_value, min_value, max_value):
    try:
        value = float(value)
    except Exception:
        value = default_value
    return max(min_value, min(value, max_value))


def resize_frame_to_height(frame, max_height):
    max_height = int(max_height or 0)
    if max_height <= 0:
        return frame
    h, w = frame.shape[:2]
    if h <= max_height:
        return frame
    scale = max_height / h
    out_w = max(1, int(round(w * scale)))
    return cv2.resize(frame, (out_w, max_height), interpolation=cv2.INTER_AREA)


class BackgroundRTSPCapture:
    def __init__(self, cap):
        self.cap = cap
        self.lock = Lock()
        self.running = True
        self.last_frame = None
        self.last_ok = False
        self.exception = None
        self.thread = Thread(target=self._reader_thread, daemon=True)
        self.thread.start()

    def _reader_thread(self):
        while self.running:
            try:
                ok, frame = self.cap.read()
                with self.lock:
                    self.last_ok = bool(ok)
                    self.last_frame = frame if ok else None
                if not ok:
                    time.sleep(0.02)
            except Exception as exc:
                self.exception = exc
                break

    def read_latest(self):
        if self.exception:
            raise self.exception
        with self.lock:
            if not self.last_ok or self.last_frame is None:
                return False, None
            return True, self.last_frame.copy()

    def release(self):
        self.running = False
        if self.thread.is_alive():
            timeout = max(2.0, (LOCAL_RTSP_READ_TIMEOUT_MS / 1000.0) + 1.0)
            self.thread.join(timeout=timeout)
        if self.thread.is_alive():
            # Do not release while FFmpeg is still inside native read(); doing
            # that can trigger libavcodec pthread assertions or crash Python.
            return
        self.cap.release()


def open_rtsp_capture(rtsp_url):
    if cv2 is None:
        raise RuntimeError(f"OpenCV is not installed: {CV2_IMPORT_ERROR}")

    ffmpeg_opts = []
    if LOCAL_RTSP_TRANSPORT in {"tcp", "udp"}:
        ffmpeg_opts.append(f"rtsp_transport;{LOCAL_RTSP_TRANSPORT}")
    if LOCAL_RTSP_LOW_LATENCY:
        ffmpeg_opts.extend(["fflags;nobuffer", "flags;low_delay"])
    ffmpeg_opts.append("threads;1")
    if ffmpeg_opts:
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "|".join(ffmpeg_opts)

    params = []
    if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
        params.extend([int(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC), LOCAL_RTSP_OPEN_TIMEOUT_MS])
    if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
        params.extend([int(cv2.CAP_PROP_READ_TIMEOUT_MSEC), LOCAL_RTSP_READ_TIMEOUT_MS])

    try:
        cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG, params) if params else cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
    except TypeError:
        cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
        if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
            cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, LOCAL_RTSP_OPEN_TIMEOUT_MS)
        if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
            cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, LOCAL_RTSP_READ_TIMEOUT_MS)
    if hasattr(cv2, "CAP_PROP_BUFFERSIZE"):
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 3)
    if not cap.isOpened():
        cap.release()
        raise RuntimeError("Cannot open RTSP stream")
    return BackgroundRTSPCapture(cap)


def stream_rtsp_mjpeg(rtsp_url, fps=LOCAL_RTSP_PREVIEW_FPS, quality=LOCAL_RTSP_JPEG_QUALITY, max_height=LOCAL_RTSP_PREVIEW_MAX_HEIGHT):
    capture = open_rtsp_capture(rtsp_url)
    fps = clamp_float(fps, LOCAL_RTSP_PREVIEW_FPS, 1.0, 30.0)
    quality = clamp_int(quality, LOCAL_RTSP_JPEG_QUALITY, 40, 95)
    max_height = clamp_int(max_height, LOCAL_RTSP_PREVIEW_MAX_HEIGHT, 0, 1440)
    interval = 1.0 / fps

    try:
        next_send = time.monotonic()
        failures = 0
        while True:
            now = time.monotonic()
            if now < next_send:
                time.sleep(next_send - now)
            ok, frame = capture.read_latest()
            if not ok:
                failures += 1
                if failures > 150:
                    raise RuntimeError("Cannot read RTSP frame")
                time.sleep(min(0.1, interval))
                continue
            failures = 0
            frame = resize_frame_to_height(frame, max_height)
            ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
            if not ok:
                continue
            next_send = time.monotonic() + interval
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" +
                encoded.tobytes() +
                b"\r\n"
            )
    finally:
        capture.release()

HOST = os.environ.get("FIRE_ALERT_HOST", "0.0.0.0")
PORT = int(os.environ.get("FIRE_ALERT_PORT", "8765"))
AUTOMATE_TOKEN = os.environ.get("AUTOMATE_TOKEN", "")
CALL_DELAY_SECONDS = int(os.environ.get("FIRE_ALERT_CALL_DELAY_SECONDS", "300"))
CALL_INITIAL_DELAY_SECONDS = int(os.environ.get("FIRE_ALERT_CALL_INITIAL_DELAY_SECONDS", "0"))
SMS_DELAY_SECONDS = int(os.environ.get("FIRE_ALERT_SMS_DELAY_SECONDS", "300"))
CALL_TIMEOUT_SECONDS = int(os.environ.get("FIRE_ALERT_CALL_TIMEOUT_SECONDS", "90"))

app = Flask(__name__, static_folder=None)

auth_users = {}
auth_sessions = {}

active_alerts = {}
alert_lock = Lock()
settings = {
    "sms_enabled": True,
    "call_enabled": True,
    "sms_delay_seconds": SMS_DELAY_SECONDS,
    "call_initial_delay_seconds": CALL_INITIAL_DELAY_SECONDS,
    "call_delay_seconds": CALL_DELAY_SECONDS,
    "call_timeout_seconds": CALL_TIMEOUT_SECONDS,
}


def cors_response(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Automate-Token"
    return response


@app.after_request
def add_cors_headers(response):
    return cors_response(response)


def is_authorized():
    if not AUTOMATE_TOKEN:
        return True
    token = request.args.get("token") or request.headers.get("X-Automate-Token", "")
    return token == AUTOMATE_TOKEN


def normalize_phone(phone):
    return str(phone or "").strip().replace(" ", "").replace("+", "")


def normalize_email(email):
    return str(email or "").strip().lower()


def hash_password(password):
    return hashlib.sha256(str(password or "").encode("utf-8")).hexdigest()


def refresh_auth_users():
    config = load_config()
    users = config.get("users") or {}
    auth_users.clear()
    for email, user in users.items():
        normalized_email = str(email).strip().lower()
        auth_users[normalized_email] = {
            **user,
            "email": normalized_email,
            "role": user.get("role", "customer"),
            "status": user.get("status", "active"),
        }
    return auth_users


def register_user(full_name, phone, email, password):
    full_name = str(full_name or "").strip()
    phone = normalize_phone(phone)
    email = normalize_email(email)
    password = str(password or "").strip()

    if not full_name or not phone or not email or not password:
        return None
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return None

    refresh_auth_users()
    if email in auth_users:
        return None

    user = {
        "email": email,
        "full_name": full_name,
        "phone": phone,
        "password_hash": hash_password(password),
        "role": "customer",
        "status": "active",
        "created_at": int(time.time()),
    }
    auth_users[email] = user

    config = load_config()
    config["users"] = auth_users
    save_config(config)
    return {"email": user["email"], "full_name": user["full_name"], "phone": user["phone"]}


def authenticate_user(email, password):
    email = normalize_email(email)
    refresh_auth_users()
    user = auth_users.get(email)
    if not user:
        return None
    if user.get("password_hash") != hash_password(password):
        return None
    if user.get("status", "active") != "active":
        return None
    return public_user(user)


def public_user(user):
    return {
        "email": user["email"],
        "full_name": user["full_name"],
        "phone": user["phone"],
        "role": user.get("role", "customer"),
        "status": user.get("status", "active"),
        "created_at": user.get("created_at"),
    }


def update_user_profile(current_email, full_name, phone, email):
    current_email = normalize_email(current_email)
    full_name = str(full_name or "").strip()
    phone = normalize_phone(phone)
    email = normalize_email(email)

    if not current_email or not full_name or not phone or not email:
        return None, "Vui lòng nhập đầy đủ họ tên, email và số điện thoại"
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return None, "Email không hợp lệ"

    refresh_auth_users()
    user = auth_users.get(current_email)
    if not user:
        return None, "Không tìm thấy tài khoản"
    if email != current_email and email in auth_users:
        return None, "Email đã tồn tại"

    updated_user = {
        **user,
        "email": email,
        "full_name": full_name,
        "phone": phone,
    }

    if email != current_email:
        auth_users.pop(current_email, None)
    auth_users[email] = updated_user

    config = load_config()
    config["users"] = auth_users
    save_config(config)

    for token, session_user in list(auth_sessions.items()):
        if normalize_email(session_user.get("email")) == current_email:
            auth_sessions[token] = public_user(updated_user)

    return public_user(updated_user), None


def create_session(user):
    token = secrets.token_urlsafe(24)
    auth_sessions[token] = user
    return token


def get_auth_token():
    authorization = request.headers.get("Authorization", "")
    if authorization.startswith("Bearer "):
        return authorization.split(" ", 1)[1].strip()

    if request.is_json:
        payload = request.get_json(silent=True) or {}
        return str(payload.get("token") or "")

    return str(request.args.get("token") or "")


def get_authenticated_user():
    token = get_auth_token()
    user = auth_sessions.get(token)
    if not user:
        return None
    return user


def get_live_authenticated_user():
    session_user = get_authenticated_user()
    if not session_user:
        return None
    refresh_auth_users()
    user = auth_users.get(normalize_email(session_user.get("email")))
    if not user or user.get("status", "active") != "active":
        auth_sessions.pop(get_auth_token(), None)
        return None
    return public_user(user)


def get_admin_user():
    user = get_live_authenticated_user()
    if not user or user.get("role") != "admin":
        return None
    return user


def active_admin_count():
    return sum(
        1 for user in auth_users.values()
        if user.get("role", "customer") == "admin" and user.get("status", "active") == "active"
    )


def create_managed_user(full_name, phone, email, password, role="customer", status="active"):
    full_name = str(full_name or "").strip()
    phone = normalize_phone(phone)
    email = normalize_email(email)
    password = str(password or "").strip()
    role = role if role in {"admin", "customer"} else "customer"
    status = status if status in {"active", "disabled"} else "active"
    if not full_name or not phone or not email or len(password) < 6:
        return None, "Họ tên, số điện thoại, email và mật khẩu tối thiểu 6 ký tự là bắt buộc"
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return None, "Email không hợp lệ"
    refresh_auth_users()
    if email in auth_users:
        return None, "Email đã tồn tại"
    user = {"email": email, "full_name": full_name, "phone": phone, "password_hash": hash_password(password), "role": role, "status": status, "created_at": int(time.time())}
    auth_users[email] = user
    config = load_config()
    config["users"] = auth_users
    save_config(config)
    return public_user(user), None


def update_managed_user(email, data, admin_email):
    email = normalize_email(email)
    refresh_auth_users()
    user = auth_users.get(email)
    if not user:
        return None, "Không tìm thấy tài khoản"
    full_name = str(data.get("full_name", user.get("full_name", ""))).strip()
    phone = normalize_phone(data.get("phone", user.get("phone", "")))
    role = data.get("role", user.get("role", "customer"))
    status = data.get("status", user.get("status", "active"))
    if not full_name or not phone or role not in {"admin", "customer"} or status not in {"active", "disabled"}:
        return None, "Thông tin tài khoản không hợp lệ"
    is_last_active_admin = user.get("role", "customer") == "admin" and user.get("status", "active") == "active" and active_admin_count() == 1
    if is_last_active_admin and (role != "admin" or status != "active"):
        return None, "Không thể thay đổi quyền hoặc khóa admin đang hoạt động cuối cùng"
    if email == normalize_email(admin_email) and (role != "admin" or status != "active"):
        return None, "Admin không thể tự hạ quyền hoặc tự khóa tài khoản"
    updated = {**user, "full_name": full_name, "phone": phone, "role": role, "status": status}
    password = str(data.get("password") or "").strip()
    if password:
        if len(password) < 6:
            return None, "Mật khẩu mới phải có ít nhất 6 ký tự"
        updated["password_hash"] = hash_password(password)
    auth_users[email] = updated
    config = load_config()
    config["users"] = auth_users
    save_config(config)
    for token, session_user in list(auth_sessions.items()):
        if normalize_email(session_user.get("email")) == email:
            if status != "active":
                auth_sessions.pop(token, None)
            else:
                auth_sessions[token] = public_user(updated)
    return public_user(updated), None


def get_request_phone(alert_phone=None):
    return normalize_phone(alert_phone)


def build_alert_message(alert):
    if alert.get("message"):
        return str(alert["message"])

    stream_name = alert.get("streamName") or "camera cảnh báo"
    level = alert.get("maxLevel") or alert.get("level") or "khẩn cấp"
    return f"Cảnh báo cháy mức độ {level} tại camera {stream_name}."


def build_new_fire_message(alert):
    stream_name = alert.get("streamName") or "camera cảnh báo"
    level = alert.get("maxLevel") or alert.get("level") or "khẩn cấp"
    return f"Cảnh báo cháy cấp độ {level} tại camera {stream_name}."


def build_level_increase_message(alert):
    stream_name = alert.get("streamName") or "camera cảnh báo"
    level = alert.get("maxLevel") or alert.get("level") or "khẩn cấp"
    return f"Cảnh báo cháy: Cấp độ cháy tăng lên cấp độ {level} tại camera {stream_name}."


def build_alert_state(alert):
    now_ms = int(time.time() * 1000)
    alert_id = str(alert.get("logId") or f"alert-{now_ms}")
    level = int(alert.get("maxLevel") or alert.get("level") or 1)
    event_type = str(alert.get("eventType") or "active")
    sms_delay_seconds = max(0, int(alert.get("smsDelaySeconds", settings["sms_delay_seconds"]) or 0))
    call_initial_delay_seconds = max(0, int(alert.get("callInitialDelaySeconds", settings["call_initial_delay_seconds"]) or 0))
    call_delay_seconds = max(5, int(alert.get("callDelaySeconds", settings["call_delay_seconds"]) or 5))
    call_timeout_seconds = max(15, int(alert.get("callTimeoutSeconds", settings["call_timeout_seconds"]) or 15))
    pending_message = alert.get("message")
    if event_type == "new" and not pending_message:
        pending_message = build_new_fire_message(alert)
    elif event_type == "level_increase" and not pending_message:
        pending_message = build_level_increase_message(alert)

    return {
        "id": alert_id,
        "stream_name": alert.get("streamName") or "camera cảnh báo",
        "phone": normalize_phone(alert.get("phone")),
        "account_email": normalize_email(alert.get("accountEmail")),
        "max_level": level,
        "active": bool(alert.get("active", True)),
        "sms_enabled": bool(alert.get("smsEnabled", settings["sms_enabled"])),
        "call_enabled": bool(alert.get("callEnabled", settings["call_enabled"])),
        "sms_delay_seconds": sms_delay_seconds,
        "call_initial_delay_seconds": call_initial_delay_seconds,
        "call_delay_seconds": call_delay_seconds,
        "call_timeout_seconds": call_timeout_seconds,
        "pending_sms_message": pending_message,
        "sms_next_at": 0.0,
        "next_sms_reminder_at": 0.0,
        "last_sms_level": level if pending_message else int(alert.get("lastSmsLevel") or 0),
        "call_next_at": float(alert.get("callNextAt") or (time.time() + call_initial_delay_seconds)),
        "call_in_progress": False,
        "call_attempt": int(alert.get("callAttempt") or 0),
        "call_started_at": 0.0,
        "created_at": now_ms,
        "updated_at": now_ms,
        "raw": alert,
    }


def upsert_alert_state(alert):
    event_type = str(alert.get("eventType") or "active")
    alert_id = str(alert.get("logId") or f"alert-{int(time.time() * 1000)}")
    now = time.time()
    now_ms = int(now * 1000)

    with alert_lock:
        if event_type == "ended" or alert.get("active") is False:
            state = active_alerts.get(alert_id)
            if state:
                state["active"] = False
                state["pending_sms_message"] = None
                state["call_in_progress"] = False
                state["updated_at"] = now_ms
            return state or {"id": alert_id, "active": False}

        state = active_alerts.get(alert_id)
        if not state or not state.get("active"):
            state = build_alert_state({**alert, "eventType": event_type if event_type != "active" else "new"})
            active_alerts[alert_id] = state
            return state

        previous_level = int(state.get("max_level") or 1)
        level = int(alert.get("maxLevel") or alert.get("level") or previous_level)
        state["active"] = True
        state["stream_name"] = alert.get("streamName") or state["stream_name"]
        state["phone"] = normalize_phone(alert.get("phone") or state["phone"])
        state["account_email"] = normalize_email(alert.get("accountEmail") or state.get("account_email"))
        if "smsEnabled" in alert:
            state["sms_enabled"] = bool(alert.get("smsEnabled"))
        if "callEnabled" in alert:
            state["call_enabled"] = bool(alert.get("callEnabled"))
        if "smsDelaySeconds" in alert:
            state["sms_delay_seconds"] = max(0, int(alert.get("smsDelaySeconds") or 0))
        if "callInitialDelaySeconds" in alert:
            state["call_initial_delay_seconds"] = max(0, int(alert.get("callInitialDelaySeconds") or 0))
        if "callDelaySeconds" in alert:
            state["call_delay_seconds"] = max(5, int(alert.get("callDelaySeconds") or 5))
        if "callTimeoutSeconds" in alert:
            state["call_timeout_seconds"] = max(15, int(alert.get("callTimeoutSeconds") or 15))
        state["max_level"] = max(previous_level, level)
        state["updated_at"] = now_ms
        state["raw"] = alert

        if event_type == "level_increase" or level > previous_level:
            state["pending_sms_message"] = alert.get("message") or build_level_increase_message({
                **alert,
                "maxLevel": state["max_level"],
                "streamName": state["stream_name"],
            })
            state["sms_next_at"] = 0.0
            state["last_sms_level"] = state["max_level"]

        return state


def text_field(value):
    return str(value or "").replace(";", ",").replace("|", "/").replace("\r", " ").replace("\n", " ")


def log_terminal_message(action_item):
    if not action_item:
        return

    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    action = str(action_item.get("action") or "").upper()
    phone = action_item.get("phone") or ""
    alert_id = action_item.get("alert_id") or ""
    message = action_item.get("message") or ""
    print(f"[{timestamp}] {action} alert_id={alert_id} phone={phone}", flush=True)
    text = f"Noi dung tin nhan: {message}"
    try:
        print(text, flush=True)
    except UnicodeEncodeError:
        encoding = sys.stdout.encoding or "utf-8"
        print(text.encode(encoding, errors="backslashreplace").decode(encoding), flush=True)


def clear_alerts_for_phone(phone):
    phone = normalize_phone(phone)
    if not phone:
        return 0

    cleared = 0
    now_ms = int(time.time() * 1000)
    with alert_lock:
        for state in active_alerts.values():
            if normalize_phone(state.get("phone")) != phone:
                continue
            if state.get("active") or state.get("pending_sms_message") or state.get("call_in_progress"):
                cleared += 1
            state["active"] = False
            state["pending_sms_message"] = None
            state["call_in_progress"] = False
            state["updated_at"] = now_ms
    return cleared


def active_alert_count():
    with alert_lock:
        return sum(1 for item in active_alerts.values() if item.get("active"))


def get_realtime_action(preferred_action=None):
    now = time.time()
    with alert_lock:
        active_items = [item for item in active_alerts.values() if item.get("active")]

        if preferred_action in (None, "sms"):
            for item in active_items:
                if not item.get("sms_enabled", settings.get("sms_enabled", True)):
                    continue
                message = item.get("pending_sms_message")
                if message and now >= float(item.get("sms_next_at") or 0):
                    item["pending_sms_message"] = None
                    sms_delay = int(item.get("sms_delay_seconds", settings.get("sms_delay_seconds")) or 0)
                    item["next_sms_reminder_at"] = now + sms_delay if sms_delay > 0 else 0.0
                    action_item = {
                        "action": "sms",
                        "alert_id": item["id"],
                        "phone": item["phone"],
                        "message": message,
                        "level": item["max_level"],
                    }
                    log_terminal_message(action_item)
                    return action_item

            for item in active_items:
                if not item.get("sms_enabled", settings.get("sms_enabled", True)):
                    continue
                sms_delay = int(item.get("sms_delay_seconds", settings.get("sms_delay_seconds")) or 0)
                if sms_delay <= 0:
                    continue
                if item.get("pending_sms_message"):
                    continue
                next_sms_at = float(item.get("next_sms_reminder_at") or 0)
                if next_sms_at and now >= next_sms_at:
                    item["next_sms_reminder_at"] = now + sms_delay
                    action_item = {
                        "action": "sms",
                        "alert_id": item["id"],
                        "phone": item["phone"],
                        "message": build_alert_message({
                            "streamName": item["stream_name"],
                            "maxLevel": item["max_level"],
                        }),
                        "level": item["max_level"],
                    }
                    log_terminal_message(action_item)
                    return action_item

        if preferred_action in (None, "call"):
            for item in active_items:
                if not item.get("call_enabled", settings.get("call_enabled", True)):
                    continue
                if item.get("call_in_progress"):
                    started_at = float(item.get("call_started_at") or 0)
                    call_timeout = int(item.get("call_timeout_seconds", settings["call_timeout_seconds"]) or settings["call_timeout_seconds"])
                    if started_at and now - started_at >= call_timeout:
                        item["call_in_progress"] = False
                        call_delay = int(item.get("call_delay_seconds", settings["call_delay_seconds"]) or settings["call_delay_seconds"])
                        item["call_next_at"] = now + call_delay
                    continue

                if now >= float(item.get("call_next_at") or 0):
                    item["call_in_progress"] = True
                    item["call_attempt"] = int(item.get("call_attempt") or 0) + 1
                    item["call_started_at"] = now
                    action_item = {
                        "action": "call",
                        "alert_id": item["id"],
                        "phone": item["phone"],
                        "message": build_alert_message({
                            "streamName": item["stream_name"],
                            "maxLevel": item["max_level"],
                        }),
                        "level": item["max_level"],
                        "attempt": item["call_attempt"],
                    }
                    log_terminal_message(action_item)
                    return action_item

    return None


@app.route("/auth/login", methods=["POST", "OPTIONS"])
def auth_login():
    if request.method == "OPTIONS":
        return ("", 204)

    data = request.get_json(silent=True) or {}
    user = authenticate_user(data.get("email", ""), data.get("password", ""))
    if not user:
        return jsonify({"success": False, "error": "Email hoặc mật khẩu không đúng"}), 401

    token = create_session(user)
    return jsonify({"success": True, "token": token, "user": user})


@app.route("/auth/register", methods=["POST", "OPTIONS"])
def auth_register():
    if request.method == "OPTIONS":
        return ("", 204)

    data = request.get_json(silent=True) or {}
    user = register_user(
        full_name=data.get("full_name", ""),
        phone=data.get("phone", ""),
        email=data.get("email", ""),
        password=data.get("password", ""),
    )
    if not user:
        return jsonify({"success": False, "error": "Thông tin không hợp lệ hoặc email đã tồn tại"}), 400

    token = create_session(user)
    return jsonify({"success": True, "token": token, "user": user})


@app.route("/auth/me")
def auth_me():
    user = get_live_authenticated_user()
    if not user:
        return jsonify({"success": False, "error": "Unauthorized"}), 401
    return jsonify({"success": True, "user": user})


@app.route("/auth/profile", methods=["POST", "OPTIONS"])
def auth_profile():
    if request.method == "OPTIONS":
        return ("", 204)

    user = get_live_authenticated_user()
    if not user:
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    updated_user, error = update_user_profile(
        current_email=user.get("email", ""),
        full_name=data.get("full_name", ""),
        phone=data.get("phone", ""),
        email=data.get("email", ""),
    )
    if not updated_user:
        return jsonify({"success": False, "error": error or "Không thể cập nhật tài khoản"}), 400

    return jsonify({"success": True, "user": updated_user})


@app.route("/admin/users", methods=["GET", "POST", "OPTIONS"])
def admin_users():
    if request.method == "OPTIONS":
        return ("", 204)
    admin = get_admin_user()
    if not admin:
        return jsonify({"success": False, "error": "Admin authorization required"}), 403
    if request.method == "GET":
        refresh_auth_users()
        users = [public_user(user) for user in auth_users.values()]
        users.sort(key=lambda item: (item.get("role") != "admin", item.get("full_name", "").lower()))
        return jsonify({"success": True, "users": users, "summary": {"total": len(users), "active": sum(item.get("status") == "active" for item in users), "disabled": sum(item.get("status") == "disabled" for item in users), "active_alerts": active_alert_count()}})
    data = request.get_json(silent=True) or {}
    user, error = create_managed_user(data.get("full_name"), data.get("phone"), data.get("email"), data.get("password"), data.get("role", "customer"), data.get("status", "active"))
    if not user:
        return jsonify({"success": False, "error": error}), 400
    return jsonify({"success": True, "user": user}), 201


@app.route("/admin/users/<path:email>", methods=["POST", "OPTIONS"])
def admin_user_update(email):
    if request.method == "OPTIONS":
        return ("", 204)
    admin = get_admin_user()
    if not admin:
        return jsonify({"success": False, "error": "Admin authorization required"}), 403
    user, error = update_managed_user(email, request.get_json(silent=True) or {}, admin.get("email"))
    if not user:
        return jsonify({"success": False, "error": error}), 400
    return jsonify({"success": True, "user": user})


@app.route("/auth/logout", methods=["POST", "OPTIONS"])
def auth_logout():
    if request.method == "OPTIONS":
        return ("", 204)

    token = get_auth_token()
    user = auth_sessions.pop(token, None)
    cleared_alerts = clear_alerts_for_phone(user.get("phone")) if user else 0
    return jsonify({"success": True, "cleared_alerts": cleared_alerts})


@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "fire.html")


@app.route("/fire.js")
def fire_js():
    return send_from_directory(BASE_DIR, "fire.js")


@app.route("/fire.css")
def fire_css():
    return send_from_directory(BASE_DIR, "fire.css")


@app.route("/auth-fire-monitor-bg.png")
def auth_bg_image():
    return send_from_directory(BASE_DIR, "auth-fire-monitor-bg.png")


@app.route("/assets/<path:filename>")
def assets(filename):
    assets_dir = os.path.join(BASE_DIR, "assets")
    if os.path.exists(os.path.join(assets_dir, filename)):
        return send_from_directory(assets_dir, filename)
    return send_from_directory(BASE_DIR, filename)


@app.route("/api/key", methods=["GET", "POST", "OPTIONS"])
def api_key_endpoint():
    if request.method == "OPTIONS":
        return ("", 204)
    
    config = load_config()
    
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        api_key = data.get("api_key", "").strip()
        if not api_key:
            return jsonify({"success": False, "message": "API Key is required"}), 400
        config["triton_api_key"] = api_key
        save_config(config)
        return jsonify({"success": True, "message": "API Key saved successfully"})
        
    return jsonify({
        "success": True,
        "api_key": config.get("triton_api_key", "")
    })


@app.route("/health")
def health():
    return jsonify({
        "ok": True,
        "service": "fire-alert-automate-bridge",
        "active_alerts": active_alert_count(),
        "settings": settings,
        "automate_token_enabled": bool(AUTOMATE_TOKEN),
    })


@app.route("/local-model/health")
def local_model_health():
    status = local_model_status()
    return jsonify({
        "success": True,
        "model": status,
    })


@app.route("/local-infer", methods=["POST", "OPTIONS"])
def local_infer():
    if request.method == "OPTIONS":
        return ("", 204)

    try:
        conf = float(request.args.get("conf", "0.5"))
    except ValueError:
        conf = 0.5
    try:
        imgsz = int(request.args.get("imgsz", "640"))
    except ValueError:
        imgsz = 640

    image_bytes = request.get_data()
    if not image_bytes and "image" in request.files:
        image_bytes = request.files["image"].read()
    if not image_bytes:
        return jsonify({"success": False, "error": "No image data"}), 400

    try:
        data = run_local_detection(image_bytes, conf=conf, imgsz=imgsz)
        data["success"] = True
        return jsonify(data)
    except Exception as exc:
        return jsonify({
            "success": False,
            "error": str(exc),
            "model": local_model_status(),
        }), 500


@app.route("/local-rtsp/preview")
def local_rtsp_preview():
    rtsp_url = request.args.get("url", "").strip()
    if not rtsp_url:
        return jsonify({"success": False, "error": "Missing RTSP URL"}), 400
    if cv2 is None:
        return jsonify({"success": False, "error": f"OpenCV is not installed: {CV2_IMPORT_ERROR}"}), 500
    fps = request.args.get("fps", LOCAL_RTSP_PREVIEW_FPS)
    quality = request.args.get("quality", LOCAL_RTSP_JPEG_QUALITY)
    max_height = request.args.get("max_height", LOCAL_RTSP_PREVIEW_MAX_HEIGHT)

    return Response(
        stream_rtsp_mjpeg(rtsp_url, fps=fps, quality=quality, max_height=max_height),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


@app.route("/system-stats", methods=["GET", "OPTIONS"])
@app.route("/api/system-stats", methods=["GET", "OPTIONS"])
def system_stats():
    if request.method == "OPTIONS":
        return ("", 204)

    if psutil is None:
        return jsonify({
            "success": False,
            "error": f"psutil not available: {PSUTIL_IMPORT_ERROR}",
            "stats": None
        }), 500

    try:
        cpu_percent = psutil.cpu_percent(interval=None)
        cpu_count_logical = psutil.cpu_count(logical=True) or 1
        cpu_count_physical = psutil.cpu_count(logical=False) or cpu_count_logical

        mem = psutil.virtual_memory()
        
        proc_mem = 0.0
        proc_cpu = 0.0
        try:
            process = psutil.Process()
            proc_mem = process.memory_info().rss / (1024 * 1024)
            proc_cpu = process.cpu_percent(interval=None)
        except Exception:
            pass

        stats = {
            "timestamp": int(time.time() * 1000),
            "cpu": {
                "percent": round(float(cpu_percent), 1),
                "cores_logical": int(cpu_count_logical),
                "cores_physical": int(cpu_count_physical),
                "process_percent": round(float(proc_cpu), 1),
            },
            "ram": {
                "total_mb": round(float(mem.total) / (1024 * 1024)),
                "used_mb": round(float(mem.used) / (1024 * 1024)),
                "free_mb": round(float(mem.available) / (1024 * 1024)),
                "percent": round(float(mem.percent), 1),
                "process_mb": round(float(proc_mem), 1),
            },
            "gpu": None,
        }

        try:
            import torch
            if torch.cuda.is_available():
                gpu_name = torch.cuda.get_device_name(0)
                gpu_allocated_mb = round(torch.cuda.memory_allocated(0) / (1024 * 1024), 1)
                gpu_reserved_mb = round(torch.cuda.memory_reserved(0) / (1024 * 1024), 1)
                gpu_total_mb = round(torch.cuda.get_device_properties(0).total_memory / (1024 * 1024), 1)
                gpu_percent = round((gpu_reserved_mb / max(1.0, gpu_total_mb)) * 100, 1)
                stats["gpu"] = {
                    "name": gpu_name,
                    "used_mb": gpu_reserved_mb,
                    "allocated_mb": gpu_allocated_mb,
                    "total_mb": gpu_total_mb,
                    "percent": gpu_percent,
                }
        except Exception:
            pass

        return jsonify({"success": True, "stats": stats})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/settings", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/fire-alert/settings", methods=["GET", "POST", "OPTIONS"])
def alert_settings():
    if request.method == "OPTIONS":
        return ("", 204)

    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        def int_setting(camel_key, snake_key, current_value):
            if camel_key in data:
                return int(data.get(camel_key))
            if snake_key in data:
                return int(data.get(snake_key))
            return int(current_value)

        if "smsEnabled" in data or "sms_enabled" in data:
            settings["sms_enabled"] = bool(data.get("smsEnabled", data.get("sms_enabled")))
        if "callEnabled" in data or "call_enabled" in data:
            settings["call_enabled"] = bool(data.get("callEnabled", data.get("call_enabled")))
        sms_delay = int_setting("smsDelaySeconds", "sms_delay_seconds", settings["sms_delay_seconds"])
        call_initial_delay = int_setting("callInitialDelaySeconds", "call_initial_delay_seconds", settings["call_initial_delay_seconds"])
        delay = int_setting("callDelaySeconds", "call_delay_seconds", settings["call_delay_seconds"])
        timeout = int_setting("callTimeoutSeconds", "call_timeout_seconds", settings["call_timeout_seconds"])
        settings["sms_delay_seconds"] = max(0, sms_delay)
        settings["call_initial_delay_seconds"] = max(0, call_initial_delay)
        settings["call_delay_seconds"] = max(5, delay)
        settings["call_timeout_seconds"] = max(15, timeout)

    return jsonify({"success": True, "settings": settings})


@app.route("/alert-state", methods=["POST", "OPTIONS"])
@app.route("/api/fire-alert/alert-state", methods=["POST", "OPTIONS"])
def alert_state():
    if request.method == "OPTIONS":
        return ("", 204)

    user = get_authenticated_user()
    if not user:
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    phone = normalize_phone(user.get("phone"))
    if not phone:
        return jsonify({"success": False, "error": "Tài khoản chưa có số điện thoại"}), 400

    alert = request.get_json(silent=True) or {}
    state = upsert_alert_state({**alert, "phone": phone})
    return jsonify({
        "success": True,
        "active": bool(state.get("active")),
        "alert_id": state.get("id"),
        "active_alerts": active_alert_count(),
    })


@app.route("/alert", methods=["POST", "OPTIONS"])
@app.route("/api/fire-alert/alert", methods=["POST", "OPTIONS"])
def update_alert_from_legacy_route():
    if request.method == "OPTIONS":
        return ("", 204)

    alert = request.get_json(silent=True) or {}
    state = upsert_alert_state({**alert, "eventType": "new", "active": True})

    return jsonify({
        "success": True,
        "active": True,
        "message_id": state["id"],
        "active_alerts": active_alert_count(),
        "message": "Realtime alert state updated for Automate",
    })


@app.route("/sms", methods=["POST", "OPTIONS"])
@app.route("/api/fire-alert/sms", methods=["POST", "OPTIONS"])
def update_sms_from_legacy_route():
    if request.method == "OPTIONS":
        return ("", 204)

    alert = request.get_json(silent=True) or {}
    state = upsert_alert_state({**alert, "eventType": "new", "active": True})

    return jsonify({
        "success": True,
        "active": True,
        "message_id": state["id"],
        "active_alerts": active_alert_count(),
        "message": "Realtime SMS alert state updated for Automate",
    })


@app.route("/automate/next")
def automate_next():
    if not is_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    item = get_realtime_action()

    if not item:
        return jsonify({"success": True, "has_alert": False, "active_alerts": active_alert_count()})

    phone = get_request_phone(item.get("phone"))
    return jsonify({
        "success": True,
        "has_alert": True,
        "alert_id": item["alert_id"],
        "action": item["action"],
        "phone": phone,
        "message": item["message"],
        "level": item.get("level"),
        "attempt": item.get("attempt", 0),
    })


@app.route("/automate/next-sms")
def automate_next_sms():
    if not is_authorized():
        return Response("0;;", status=401, mimetype="text/plain")

    item = get_realtime_action("sms")
    if not item:
        return Response("0;;", mimetype="text/plain")

    phone = get_request_phone(item.get("phone"))
    body = f"1;{text_field(phone)};{text_field(item['message'])}"
    return Response(body, mimetype="text/plain")


@app.route("/automate/next-sms-json")
def automate_next_sms_json():
    if not is_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    item = get_realtime_action("sms")
    if not item:
        return jsonify({"success": True, "has_alert": False, "active_alerts": active_alert_count()})

    phone = get_request_phone(item.get("phone"))
    return jsonify({
        "success": True,
        "has_alert": True,
        "alert_id": item["alert_id"],
        "action": "sms",
        "phone": phone,
        "message": item["message"],
        "level": item.get("level"),
        "attempt": 0,
    })


@app.route("/automate/next-call")
def automate_next_call():
    if not is_authorized():
        return Response("0;;", status=401, mimetype="text/plain")

    item = get_realtime_action("call")
    if not item:
        return Response("0;;", mimetype="text/plain")

    phone = get_request_phone(item.get("phone"))
    body = f"1;{text_field(phone)};{text_field(item['message'])}"
    return Response(body, mimetype="text/plain")


@app.route("/automate/next-call-json")
def automate_next_call_json():
    if not is_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    item = get_realtime_action("call")
    if not item:
        return jsonify({"success": True, "has_alert": False, "active_alerts": active_alert_count()})

    phone = get_request_phone(item.get("phone"))
    return jsonify({
        "success": True,
        "has_alert": True,
        "alert_id": item["alert_id"],
        "action": "call",
        "phone": phone,
        "message": item["message"],
        "level": item.get("level"),
        "attempt": item.get("attempt", 0),
    })

def automate_next_action_text():
    if not is_authorized():
        return Response("0;;", status=401, mimetype="text/plain")

    item = get_realtime_action()
    if not item:
        return Response("0", mimetype="text/plain")

    # Keep action;phone;message format but drop alert_id for Automate compatibility
    phone = get_request_phone(item.get("phone"))
    body = f"{text_field(item['action'])};{text_field(phone)};{text_field(item['message'])}"
    return Response(body, mimetype="text/plain")


@app.route("/automate/next-sms-text")
def automate_next_sms_text():
    if not is_authorized():
        return Response("0;;", status=401, mimetype="text/plain")

    item = get_realtime_action("sms")
    if not item:
        return Response("0;;", mimetype="text/plain")

    phone = get_request_phone(item.get("phone"))
    body = f"1;{text_field(phone)};{text_field(item['message'])}"
    return Response(body, mimetype="text/plain")


@app.route("/automate/next-call-text")
def automate_next_call_text():
    if not is_authorized():
        return Response("0;;", status=401, mimetype="text/plain")

    item = get_realtime_action("call")
    if not item:
        return Response("0;;", mimetype="text/plain")

    phone = get_request_phone(item.get("phone"))
    body = f"1;{text_field(phone)};{text_field(item['message'])}"
    return Response(body, mimetype="text/plain")


@app.route("/automate/next-text")
def automate_next_text():
    if not is_authorized():
        return Response("0;;Unauthorized", status=401, mimetype="text/plain")

    item = get_realtime_action("sms")
    if not item:
        return Response("0;;", mimetype="text/plain")

    phone = get_request_phone(item.get("phone"))
    body = f"1;{text_field(phone)};{text_field(item['message'])}"
    return Response(body, mimetype="text/plain")


@app.route("/automate/next-message")
def automate_next_message():
    if not is_authorized():
        return Response("0;;", status=401, mimetype="text/plain")

    item = get_realtime_action("sms")
    if not item:
        return Response("0;;", mimetype="text/plain")

    phone = get_request_phone(item.get("phone"))
    body = f"1;{text_field(phone)};{text_field(item['message'])}"
    return Response(body, mimetype="text/plain")


@app.route("/automate/call-result", methods=["POST", "OPTIONS"])
def automate_call_result():
    if request.method == "OPTIONS":
        return ("", 204)
    if not is_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or request.form.to_dict() or {}
    alert_id = str(data.get("alert_id") or data.get("alertId") or data.get("id") or "")
    status = str(data.get("status") or "ended").lower()
    now = time.time()

    with alert_lock:
        state = active_alerts.get(alert_id)
        if not state:
            return jsonify({"success": True, "active": False, "message": "Alert is no longer active"})

        state["call_in_progress"] = False
        state["last_call_status"] = status
        state["updated_at"] = int(now * 1000)

        if not state.get("active"):
            return jsonify({"success": True, "active": False})

        if status in ("answered", "accepted", "connected"):
            state["call_next_at"] = float("inf")
            next_call_at = state["call_next_at"]
        else:
            call_delay = int(state.get("call_delay_seconds", settings["call_delay_seconds"]) or settings["call_delay_seconds"])
            state["call_next_at"] = now + call_delay
            next_call_at = state["call_next_at"]

    return jsonify({
        "success": True,
        "active": True,
        "status": status,
        "next_call_in_seconds": None if next_call_at == float("inf") else max(0, int(next_call_at - now)),
    })


@app.route("/automate/call-result-text")
def automate_call_result_text():
    if not is_authorized():
        return Response("0", status=401, mimetype="text/plain")

    alert_id = str(request.args.get("alert_id") or request.args.get("alertId") or request.args.get("id") or "")
    status = str(request.args.get("status") or "ended").lower()
    now = time.time()

    with alert_lock:
        state = active_alerts.get(alert_id)
        if not state:
            return Response("0", mimetype="text/plain")

        state["call_in_progress"] = False
        state["last_call_status"] = status
        state["updated_at"] = int(now * 1000)

        if not state.get("active"):
            return Response("0", mimetype="text/plain")

        if status in ("answered", "accepted", "connected"):
            state["call_next_at"] = float("inf")
            return Response("1;answered;", mimetype="text/plain")

        call_delay = int(state.get("call_delay_seconds", settings["call_delay_seconds"]) or settings["call_delay_seconds"])
        state["call_next_at"] = now + call_delay
        return Response(f"1;{text_field(status)};{max(0, int(state['call_next_at'] - now))}", mimetype="text/plain")


@app.route("/automate/pending")
def automate_pending():
    if not is_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401
    return jsonify({"success": True, "active_alerts": active_alert_count(), "settings": settings})


if __name__ == "__main__":
    print(f"Fire Alert Automate bridge running on http://{HOST}:{PORT}")
    print("Open the web app from another device with http://<PC-IP>:8765/")
    app.run(host=HOST, port=PORT, debug=False)
