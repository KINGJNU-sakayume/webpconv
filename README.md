# WebP 변환기

WebP 파일을 iOS 사진앱에서 재생 가능한 형식(MP4 · JPEG)으로 변환하는 웹 앱입니다. 브라우저에서 모든 처리가 이루어지며 파일이 외부 서버로 전송되지 않습니다.

- **애니메이션 WebP → MP4** (H.264, iOS 호환)
- **정지 WebP → JPEG** (품질 0.92)
- 드래그 앤 드롭 · 다중 파일 일괄 처리 · ZIP 일괄 다운로드
- iOS Safari 우선 모바일 친화 UI
- **Service Worker로 영구 캐싱** — 첫 방문 이후 오프라인에서도 동작

## 사용법

1. 페이지를 엽니다.
2. WebP 파일을 드롭존에 끌어다 놓거나 클릭해서 선택합니다.
3. 자동으로 애니메이션 / 정지 이미지를 판별해 변환합니다.
4. **다운로드** 버튼으로 변환된 파일을 받습니다.
5. iPhone에서는 **공유 → 사진에 저장**을 눌러 사진앱에 추가하세요.

## GitHub Pages 배포 방법

1. GitHub에서 새 리포지토리를 만듭니다 (예: `webp-converter`).
2. 이 코드를 `main` 브랜치에 푸시합니다.

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<username>/<repo-name>.git
   git push -u origin main
   ```

3. 리포지토리 → **Settings** → **Pages**로 이동합니다.
4. **Source**를 `Deploy from a branch`로 두고 **Branch**를 `main`, 폴더를 `/ (root)`로 선택한 뒤 **Save**합니다.
5. 약 1분 후 `https://<username>.github.io/<repo-name>/` 에서 앱을 사용할 수 있습니다.

> 참고: 리포지토리 루트의 `.nojekyll` 파일은 Jekyll이 일부 파일을 누락하지 않도록 합니다(특히 `vendor/` 안의 파일들). 이 파일은 배포에 반드시 필요하니 삭제하지 마세요.

## 제한 사항

- **정지 이미지**: 최대 50MB. 픽셀 수가 너무 많은 경우 자동으로 안전한 크기로 다운스케일됩니다.
- **애니메이션**: 최대 20MB (모바일 메모리 한계 때문에 보수적으로 설정).
- **브라우저**: WebAssembly · Canvas · FileReader를 지원하는 최신 브라우저 (Chrome, Safari 15+, Firefox, Edge).
- **첫 방문**: 변환 엔진(약 31MB)을 한 번 내려받습니다. Service Worker가 설치되면 **이후 모든 방문에서 네트워크 없이 즉시 사용 가능**합니다.

## 작동 원리

| 단계 | 처리 |
|---|---|
| 자산 로드 | `vendor/ffmpeg/`(같은 origin)에서 우선 시도하고, 실패 시에만 jsdelivr·unpkg를 폴백 |
| 캐싱 | `sw.js`가 모든 앱·엔진 파일을 Cache Storage에 영구 보관 |
| 판별 | RIFF/WebP 컨테이너의 `VP8X` 청크 플래그(0x02) 또는 `ANMF` 청크 존재 여부로 애니메이션 여부 결정 |
| 정지 이미지 | `createImageBitmap` → `OffscreenCanvas`(또는 `<canvas>`) → `convertToBlob('image/jpeg', 0.92)` |
| 애니메이션 | `ffmpeg.wasm` (단일 스레드) → `libx264` + `yuv420p` + `+faststart` + 짝수 크기 스케일 |

## 디렉토리 구조

```
.
├── index.html
├── style.css
├── main.js
├── sw.js                     ← Service Worker (캐싱)
├── lib/                      ← 모듈화된 변환 로직
│   ├── convertAnimated.js
│   ├── convertStatic.js
│   ├── detect.js
│   ├── ui.js
│   └── zip.js
└── vendor/                   ← 동봉된 third-party 자산
    ├── README.md             ← 라이선스·재빌드 방법
    ├── ffmpeg/
    │   ├── util.js
    │   ├── ffmpeg.js
    │   ├── 814.ffmpeg.js
    │   ├── ffmpeg-core.js
    │   └── ffmpeg-core.wasm  ← ~31 MB (한 번만 받음)
    └── jszip/
        └── jszip.min.js
```

## 라이선스

이 프로젝트의 코드는 MIT.

`vendor/` 안에 동봉된 third-party 라이브러리(`@ffmpeg/ffmpeg`, `@ffmpeg/util`, `@ffmpeg/core`, `JSZip`)는 각각의 라이선스를 따릅니다. 자세한 내용은 [`vendor/README.md`](vendor/README.md)를 참고하세요.
