use napi::bindgen_prelude::*;
use napi_derive::napi;
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
    D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter, IDXGIDevice, IDXGIOutput, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource,
    DXGI_OUTDUPL_FRAME_INFO,
};

/// 노치 영역 픽셀(BGRA, 위에서 아래 순서)을 담는 결과.
#[napi(object)]
pub struct CapturedRegion {
    pub width: u32,
    pub height: u32,
    pub data: Buffer,
}

/// 화면 한 프레임을 복사하기 위해 DXGI Desktop Duplication 세션을 만든다.
struct Duplicator {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    screen_width: u32,
    screen_height: u32,
}

impl Duplicator {
    fn new() -> windows::core::Result<Self> {
        unsafe {
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
            let device = device.expect("D3D11 device");
            let context = context.expect("D3D11 context");

            let dxgi_device: IDXGIDevice = device.cast()?;
            let adapter: IDXGIAdapter = dxgi_device.GetAdapter()?;
            let output: IDXGIOutput = adapter.EnumOutputs(0)?;
            let output1: IDXGIOutput1 = output.cast()?;
            let desc = IDXGIOutput::GetDesc(&output)?;
            let rect = desc.DesktopCoordinates;
            let duplication = output1.DuplicateOutput(&device)?;

            Ok(Self {
                device,
                context,
                duplication,
                screen_width: (rect.right - rect.left) as u32,
                screen_height: (rect.bottom - rect.top) as u32,
            })
        }
    }

    /// 다음 프레임을 가져와 (x, y, w, h) 영역만 BGRA 바이트로 복사한다.
    fn grab(&self, x: u32, y: u32, w: u32, h: u32) -> windows::core::Result<Vec<u8>> {
        unsafe {
            // 첫 프레임은 리소스가 비어 있을 수 있으므로 준비될 때까지 몇 번 재시도한다.
            for _ in 0..30 {
                let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
                let mut resource: Option<IDXGIResource> = None;
                self.duplication.AcquireNextFrame(100, &mut info, &mut resource)?;
                let Some(resource) = resource else {
                    self.duplication.ReleaseFrame()?;
                    continue;
                };
                let result = self.copy_region(resource, x, y, w, h);
                self.duplication.ReleaseFrame()?;
                return result;
            }
            Err(windows::core::Error::from_hresult(windows::core::HRESULT(-1)))
        }
    }

    fn copy_region(
        &self,
        resource: IDXGIResource,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    ) -> windows::core::Result<Vec<u8>> {
        unsafe {
            let frame: ID3D11Texture2D = resource.cast()?;

            let mut src_desc = D3D11_TEXTURE2D_DESC::default();
            frame.GetDesc(&mut src_desc);

            // CPU 읽기용 스테이징 텍스처(전체 화면 크기)를 만든다.
            let staging_desc = D3D11_TEXTURE2D_DESC {
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
                ..src_desc
            };
            let mut staging: Option<ID3D11Texture2D> = None;
            self.device
                .CreateTexture2D(&staging_desc, None, Some(&mut staging))?;
            let staging = staging.expect("staging texture");

            self.context.CopyResource(&staging, &frame);

            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;

            let row_pitch = mapped.RowPitch as usize;
            let base = mapped.pData as *const u8;
            let mut out = Vec::with_capacity((w * h * 4) as usize);

            // 노치 영역이 화면 밖으로 나가지 않도록 범위를 제한한다.
            let x_end = (x + w).min(self.screen_width);
            let y_end = (y + h).min(self.screen_height);
            for row in y..y_end {
                let line = base.add(row as usize * row_pitch + x as usize * 4);
                let bytes = std::slice::from_raw_parts(line, ((x_end - x) * 4) as usize);
                out.extend_from_slice(bytes);
            }

            self.context.Unmap(&staging, 0);
            Ok(out)
        }
    }
}

/// DXGI Desktop Duplication으로 주 모니터 화면의 (x, y, width, height) 영역을 가져온다.
/// 화면 변화가 없는 프레임은 실패로 돌아오므로 호출 측에서 재시도한다.
#[napi]
pub fn capture_region(x: u32, y: u32, width: u32, height: u32) -> Result<CapturedRegion> {
    let dup = Duplicator::new().map_err(|e| Error::from_reason(e.to_string()))?;
    let data = dup
        .grab(x, y, width, height)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(CapturedRegion {
        width,
        height,
        data: Buffer::from(data),
    })
}
