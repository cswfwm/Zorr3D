package com.zorr3d;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * 编辑器外壳：全屏 WebView 加载打包在 assets 里的单文件编辑器。
 * 不使用 XML 布局，避免资源编译依赖；WebView 用代码创建，兼容 API 26+。
 */
public class MainActivity extends Activity {

    private WebView web;
    private int navDepth = 0;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF14161A);

        web = new WebView(this);
        web.setBackgroundColor(0xFF14161A);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        // WebGL2 在 Android 14 的 WebView 上默认可用；这里只关掉不需要的能力
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }

        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // 页面之间用 query 标记是否来自导航页，便于返回键回到首页
                if (url.contains("editor.html") || url.contains("runner.html")) {
                    navDepth = 1;
                }
                view.loadUrl(url);
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage msg) {
                // 着色器编译错误等会打到 logcat：adb logcat -s Zorr3D
                android.util.Log.i("Zorr3D", msg.message() + " @" + msg.lineNumber());
                return true;
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);

        web.loadUrl("file:///android_asset/index.html");

        // 保持常亮，编辑时不熄屏
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    public void onBackPressed() {
        // 先返回导航页，再退出
        if (navDepth > 0) {
            navDepth = 0;
            if (web != null) web.loadUrl("file:///android_asset/index.html");
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        new android.app.AlertDialog.Builder(this)
                .setTitle("退出编辑器")
                .setMessage("未保存的场景会丢失，确定退出？")
                .setNegativeButton("取消", null)
                .setPositiveButton("退出", (d, w) -> finish())
                .show();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
