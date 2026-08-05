# 스마트 대국 (모바일) — AI 개발 기준서

> 이 파일은 Claude가 작업 시작 전 반드시 읽고 전 항목을 준수해야 한다.
> PC 버전 원본: `D:\바둑\pc_대국`

---

## 1. ⚠️ 버전 관리

### 작업 순서

```
1. _versions/ 최신 버전 확인
2. 스냅샷 생성 후 루트 파일 수정
3. 잘못됐을 때 → 스냅샷 복원
```

### 스냅샷 생성

```powershell
$vdir = "D:\바둑\smart_source\smart_대국\_versions\20260805_v1.2"
New-Item -ItemType Directory -Path "$vdir\public" -Force | Out-Null
Copy-Item "D:\바둑\smart_source\smart_대국\server.js"           "$vdir\server.js"
Copy-Item "D:\바둑\smart_source\smart_대국\game.js"             "$vdir\game.js"
Copy-Item "D:\바둑\smart_source\smart_대국\db.js"               "$vdir\db.js"
Copy-Item "D:\바둑\smart_source\smart_대국\package.json"        "$vdir\package.json"
Copy-Item "D:\바둑\smart_source\smart_대국\public\index.html"   "$vdir\public\index.html"
Copy-Item "D:\바둑\smart_source\smart_대국\public\room.html"    "$vdir\public\room.html"
Copy-Item "D:\바둑\smart_source\smart_대국\public\login.html"   "$vdir\public\login.html"
Copy-Item "D:\바둑\smart_source\smart_대국\public\sw.js"        "$vdir\public\sw.js"
Copy-Item "D:\바둑\smart_source\smart_대국\public\manifest.json" "$vdir\public\manifest.json"
```

### 복원

```powershell
$src = "D:\바둑\smart_source\smart_대국\_versions\20260805_v1.1"
Copy-Item "$src\public\index.html" "D:\바둑\smart_source\smart_대국\public\index.html" -Force
```

---

## 2. PC 버전과의 차이

| 항목 | PC (`pc_대국`) | 모바일 (`smart_대국`) |
|------|---------------|----------------------|
| 포트 | 3100 | 3101 |
| 레이아웃 | 사이드바 | 탭 + FAB |
| 온라인 유저 | 우측 패널 | 탭으로 분리 |
| 방 만들기 | 상단 버튼 | 우하단 FAB (＋) |
| PWA | 없음 | manifest.json + sw.js |
| 서비스워커 | 없음 | network-first |

---

## 3. PWA 구조

```
public/
├── index.html     ← 모바일 전용 로비 (탭 구조)
├── room.html      ← 대국실 (PC와 동일, PWA 메타 추가)
├── login.html     ← 로그인 (PWA 메타 추가)
├── manifest.json  ← PWA 설치 정보
├── sw.js          ← 서비스워커 (network-first)
├── icon-192.png
└── icon-512.png
```

### 서비스워커 규칙
- HTML 페이지: **network-first** (항상 최신 유지)
- 아이콘/manifest: cache-first
- `/socket.io`, `/api/`, `/auth/`, `/sgf/` 경로: 서비스워커 통과 금지 (직접 네트워크)

---

## 4. 서버 (server.js)

PC 버전과 동일한 코드. 차이점:
- 기본 포트: **3101** (`.env.example` 참고)
- DB: `DATA_DIR` 환경변수로 경로 지정 (Railway Volume: `/data`)

---

## 5. GitHub 배포 흐름

```
git push → GitHub → Railway 자동 배포
환경변수: PORT=3101, SESSION_SECRET=..., DATA_DIR=/data
Railway Volume: Mount Path /data
```

---

## 6. 버전 히스토리

| 버전 | 날짜 | 내용 |
|------|------|------|
| v1.0 | 2026-08-05 | pc_대국 소스 기반 복사 (모바일 작업 시작 전) |
| v1.1 | 2026-08-05 | 모바일 PWA 구성 — manifest, sw.js, index.html 모바일 전용 재작성 |

> 작업 완료 시 이 테이블에 추가할 것.
