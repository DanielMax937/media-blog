import { chromium, Browser, BrowserContext, Page } from 'patchright';
import path from 'path';
import os from 'os';
import fs from 'fs';

interface ProxyConfig {
    server: string;
    username?: string;
    password?: string;
}

interface MCPManagerOptions {
    userDataDir?: string;
    browserId?: string;
    proxyConfig?: ProxyConfig;
}

interface TabInfo {
    page: Page;
    website: string;
}

export class MCPManagerPW {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private context: BrowserContext | null = null;
    private maxRetries = 3;
    private retryDelay = 5000;
    private consecutiveFailures = 0;
    private tabs = new Map<string, TabInfo>();
    private userDataDir: string;
    private browserId: string | null;
    private proxyConfig: ProxyConfig | null;

    constructor(options: MCPManagerOptions = {}) {
        this.userDataDir = options.userDataDir || path.join(os.tmpdir(), 'playwright-automation-user-data');
        this.browserId = options.browserId || null;
        this.proxyConfig = options.proxyConfig || null;
    }

    generateTabId(): string {
        return `tab-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }

    registerTab(page: Page, website: string): string {
        const tabId = this.generateTabId();
        this.tabs.set(tabId, { page, website });
        this.page = page;
        console.log(`📌 Registered tab: ${tabId} (${website})`);
        return tabId;
    }

    getPageByTabId(tabId: string): Page | null {
        const tab = this.tabs.get(tabId);
        return tab ? tab.page : null;
    }

    getTabInfo(tabId: string): TabInfo | null {
        return this.tabs.get(tabId) || null;
    }

    unregisterTab(tabId: string): void {
        const tab = this.tabs.get(tabId);
        if (tab) {
            console.log(`🗑️ Unregistered tab: ${tabId} (${tab.website})`);
            this.tabs.delete(tabId);
        }
    }

    async startMCPProcess(): Promise<void> {
        const browserPrefix = this.browserId ? `[Browser #${this.browserId}] ` : '';
        console.log(`🟢 ${browserPrefix}启动 MCP 进程 (Playwright)...`);
        console.log(`   📂 UserDataDir: ${this.userDataDir}`);
        try {
            const userDataDir = this.userDataDir;

            if (!fs.existsSync(userDataDir)) {
                fs.mkdirSync(userDataDir, { recursive: true });
            }

            console.log('📌 使用 playwright 连接到现有 Chrome 浏览器');

            const launchOptions: any = {
                channel: "chrome",
                headless: true,
                viewport: null,
            };

            if (this.proxyConfig) {
                console.log(`🌐 使用代理: ${this.proxyConfig.server}`);
                launchOptions.proxy = {
                    server: `http://${this.proxyConfig.server}`,
                    username: this.proxyConfig.username,
                    password: this.proxyConfig.password
                };
            } else {
                console.log('🌐 不使用代理');
            }

            // Use launch instead of launchPersistentContext for now to avoid EPERM issues in Next.js
            // console.log('📌 使用 chromium.launch (非持久化) for debugging');
            // this.browser = await chromium.launch({
            //     channel: "chrome",
            //     headless: false,
            // });
            // this.context = await this.browser.newContext({
            //     viewport: null
            // });
            try {
                console.log('📌 尝试使用 launchPersistentContext (持久化)...');
                this.context = await chromium.launchPersistentContext(userDataDir, launchOptions);
            } catch (error: any) {
                console.warn(`⚠️ launchPersistentContext 失败 (${error.message})，尝试使用 launch (非持久化)...`);
                this.browser = await chromium.launch({
                    channel: "chrome",
                    headless: false,
                });
                this.context = await this.browser.newContext({
                    viewport: null
                });
            }

            try {
                await this.context.grantPermissions(['clipboard-read', 'clipboard-write']);
                console.log('✅ 已授予剪贴板权限');
            } catch (permError: any) {
                console.warn('⚠️ 授予剪贴板权限失败，复制按钮功能可能受影响:', permError.message);
            }

            try {
                const pages = this.context.pages();
                if (pages.length > 0) {
                    this.page = pages[0];
                } else {
                    this.page = await this.context.newPage();
                }
                // const folderName = userDataDir.split("/").pop();
                // await this.page.goto('https://www.baidu.com/img/flexible/logo/pc/result@2.png?no='+folderName?.split("-")?.[1]);
                // console.log('✅ 百度首页已打开');
            } catch (navError: any) {
                console.warn('⚠️ 打开初始页面失败:', navError.message);
            }

            console.log('✅ MCP 进程已启动 (Playwright)');
            this.consecutiveFailures = 0;
        } catch (error: any) {
            console.error('❌ MCP 进程启动失败:', error.message);
            throw error;
        }
    }

    async isMCPProcessHealthy(): Promise<boolean> {
        if (!this.context) {
            console.log('🔍 健康检查: context 为空');
            return false;
        }

        try {
            const pages = this.context.pages();
            console.log(`🔍 健康检查: context 有效，当前页面数: ${pages.length}`);
            return true;
        } catch (error: any) {
            console.log(`🔍 健康检查: context 已损坏 - ${error.message}`);
            return false;
        }
    }

    async restartMCPProcess(): Promise<void> {
        console.log('🔄 重启MCP进程 (Playwright)...');
        await this.closeMCPProcess();
        await this.sleep(2000);
        await this.startMCPProcess();
        console.log('✅ MCP进程重启完成 (Playwright)');
    }

    async closeMCPProcess(): Promise<void> {
        const browserPrefix = this.browserId ? `[Browser #${this.browserId}] ` : '';
        console.log(`🔄 ${browserPrefix}closeMCPProcess() 被调用`);

        if (this.context) {
            console.log(`🔄 ${browserPrefix}关闭浏览器上下文 (Playwright)...`);
            try {
                const isConnected = this.context.browser()?.isConnected();
                console.log(`   ${browserPrefix}上下文连接状态: ${isConnected ? '已连接' : '已断开'}`);

                await this.context.close();
                console.log(`✅ ${browserPrefix}浏览器上下文已关闭 (Playwright)`);
            } catch (error: any) {
                console.error(`❌ ${browserPrefix}关闭浏览器上下文失败:`, error.message);
            }
            this.context = null;
            this.page = null;
        } else {
            console.log(`⚠️  ${browserPrefix}浏览器上下文已经为空，跳过关闭`);
        }

        if (this.browser) {
            console.log(`🔄 ${browserPrefix}关闭浏览器实例...`);
            try {
                await this.browser.close();
                console.log(`✅ ${browserPrefix}浏览器实例已关闭`);
            } catch (error: any) {
                console.error(`❌ ${browserPrefix}关闭浏览器实例失败:`, error.message);
            }
            this.browser = null;
        }

        console.log(`✅ ${browserPrefix}closeMCPProcess() 完成`);
    }

    async callMCPToolWithRetry(toolName: string, parameters: any, timeoutMs = 30000, tabId: string | null = null): Promise<any> {
        let lastError: any = null;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                console.log(`🔄 尝试调用工具 (第${attempt}次): ${toolName}${tabId ? ` [tab: ${tabId}]` : ''}`);

                if (attempt === 1 || this.consecutiveFailures > 0) {
                    const lastErrorWasPageClosed = lastError && lastError.message && (
                        lastError.message.includes('页面已关闭') ||
                        lastError.message.includes('页面未初始化') ||
                        lastError.message.includes('no page found') ||
                        lastError.message.includes('Target closed') ||
                        lastError.message.includes('Page closed')
                    );

                    if (!lastErrorWasPageClosed && !await this.isMCPProcessHealthy()) {
                        // Auto-start if not healthy/started
                        if (!this.context) {
                            await this.startMCPProcess();
                        }
                        // If still not healthy, maybe restart? For now just proceed to try.
                    }
                }

                // Ensure process is started
                if (!this.context) {
                    await this.startMCPProcess();
                }

                const result = await this.callPlaywrightMethod(toolName, parameters, timeoutMs, tabId);
                console.log(`✅ 工具调用成功 (第${attempt}次): ${toolName}`);

                this.consecutiveFailures = 0;
                return result;

            } catch (error: any) {
                lastError = error;

                const isPageClosedError = error.message && (
                    error.message.includes('Target closed') ||
                    error.message.includes('Page closed') ||
                    error.message.includes('页面未初始化或已关闭') ||
                    error.message.includes('页面不存在') ||
                    error.message.includes('no page found') ||
                    error.message.includes('Execution context was destroyed') ||
                    error.message.includes('Session closed')
                );

                if (isPageClosedError) {
                    console.error(`❌ 页面已关闭或未找到: ${toolName} (可能是超时中止)`);
                    throw new Error(`页面已关闭: ${error.message}`);
                }

                this.consecutiveFailures++;
                const page = this.getPage(tabId);
                console.error(`❌ 工具调用失败 (第${attempt}次): ${toolName} ${tabId ? ` [tab: ${tabId}]` : 'no tab'} ${page ? ` [page: ${page.url()}]` : 'no page found'}`, error.message);

                if (attempt < this.maxRetries) {
                    console.log(`⏳ 等待${this.retryDelay}ms后重试...`);
                    await this.sleep(this.retryDelay);
                }
            }
        }

        console.error(`💥 工具调用最终失败: ${toolName} (已重试${this.maxRetries}次)`);
        throw new Error(`工具调用失败: ${toolName} - ${lastError.message}`);
    }

    async callPlaywrightMethod(methodName: string, parameters: any, timeoutMs: number, tabId: string | null = null): Promise<any> {
        const page = this.getPage(tabId);
        console.log("methodName", methodName, tabId, page ? page.url() : 'no page found');
        switch (methodName) {
            case 'mcp_playwright_browser_navigate':
                return await this.navigate(parameters);
            case 'mcp_playwright_browser_click':
                return await this.click(parameters, tabId);
            case 'mcp_playwright_browser_type':
                return await this.type(parameters, tabId);
            case 'mcp_playwright_browser_snapshot':
                return await this.snapshot(parameters, tabId);
            case 'mcp_playwright_browser_tabs':
                return await this.getTabs(parameters);
            case 'mcp_playwright_browser_close_current_tab':
                return await this.closeCurrentTab(tabId);
            case 'mcp_playwright_browser_reload':
                return await this.reload(parameters, tabId);
            case 'mcp_playwright_browser_screenshot':
                return await this.screenshot(parameters, tabId);
            case 'mcp_playwright_browser_get_content':
                return await this.getContent(parameters);
            default:
                throw new Error(`未知的方法名: ${methodName}`);
        }
    }

    async navigate(params: { url: string; isNew?: boolean; website?: string }): Promise<{ success: boolean; tabId?: string }> {
        const url = params.url;
        const website = params.website || 'unknown';

        if (!url) {
            throw new Error('navigate() requires url parameter');
        }

        let targetPage: Page;
        let tabId: string | undefined = undefined;

        if (!this.context) {
            await this.startMCPProcess();
        }

        if (params.isNew) {
            targetPage = await this.context!.newPage();
            tabId = this.registerTab(targetPage, website);
        } else {
            if (!this.page || this.page.isClosed()) {
                const pages = this.context!.pages();
                if (pages.length > 0 && !pages[0].isClosed()) {
                    targetPage = pages[0];
                } else {
                    targetPage = await this.context!.newPage();
                }
                this.page = targetPage;
            } else {
                targetPage = this.page;
            }
        }

        try {
            const currentUrl = targetPage.url();
            const cleanCurrentUrl = currentUrl.split('?')[0];
            const cleanTargetUrl = url.split('?')[0];

            if (cleanCurrentUrl === cleanTargetUrl) {
                console.log(`✅ 页面已在目标位置: ${cleanCurrentUrl}`);
                return { success: true, tabId };
            }
            console.log(`📂 从 ${cleanCurrentUrl} 导航到 ${url}`);
            await targetPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.sleep(1000);
            console.log(`✅ 导航完成: ${targetPage.url()}`);
            return { success: true, tabId };
        } catch (error: any) {
            console.log(`⚠️ 导航超时: ${error.message}`);
            if (targetPage.isClosed()) {
                targetPage = await this.context!.newPage();
                this.page = targetPage;
                if (params.isNew) {
                    tabId = this.registerTab(targetPage, website);
                }
                await targetPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await this.sleep(1000);
            } else {
                const currentUrl = targetPage.url();
                if (currentUrl !== 'about:blank' && currentUrl.includes(new URL(url).hostname)) {
                    console.log(`⚠️ 部分加载成功: ${currentUrl}`);
                    return { success: true, tabId };
                }
                throw error;
            }
            return { success: true, tabId };
        }
    }

    async reload(params: any = {}, tabId: string | null = null): Promise<{ success: boolean }> {
        const page = this.getPage(tabId);

        if (!page || page.isClosed()) {
            throw new Error('页面未初始化或已关闭');
        }

        try {
            const currentUrl = page.url();
            console.log(`🔄 刷新页面: ${currentUrl}`);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.sleep(1000);
            console.log(`✅ 页面刷新完成: ${page.url()}`);
            return { success: true };
        } catch (error: any) {
            console.log(`⚠️ 页面刷新失败: ${error.message}`);
            throw error;
        }
    }

    async click(params: { element?: string; ref?: string; selector?: string }, tabId: string | null = null): Promise<{ success: boolean }> {
        const { element, ref, selector } = params;
        const page = this.getPage(tabId);

        if (!page || page.isClosed()) {
            throw new Error('页面未初始化或已关闭');
        }

        if (selector) {
            await page.click(selector, { timeout: 10000 });
        } else if (ref && ref.startsWith('#')) {
            await page.click(ref, { timeout: 10000 });
        } else if (ref) {
            await page.locator(`[data-refid="${ref}"]`).click({ timeout: 10000 });
        } else if (element) {
            await page.click(element, { timeout: 10000 });
        } else {
            throw new Error('click 方法需要 selector, ref 或 element 参数');
        }

        return { success: true };
    }

    async type(params: { element?: string; ref?: string; text?: string; selector?: string }, tabId: string | null = null): Promise<{ success: boolean }> {
        const { element, ref, text, selector } = params;
        const page = this.getPage(tabId);

        if (!page || page.isClosed()) {
            throw new Error('页面未初始化或已关闭');
        }

        let locator;

        if (selector) {
            locator = page.locator(selector);
        } else if (ref) {
            locator = page.locator(ref);
        } else if (element) {
            locator = page.locator(element);
        } else {
            locator = page.locator('textarea:visible').first();
        }

        await locator.fill(text || '');
        return { success: true };
    }

    async snapshot(params: any, tabId: string | null = null): Promise<{ nodes: any[] }> {
        console.log('📸 获取页面快照...');

        let page = this.getPage(tabId);

        if (!page || page.isClosed()) {
            const pages = this.context?.pages() || [];
            if (pages.length > 0 && !pages[0].isClosed()) {
                page = pages[0];
                this.page = page;
            } else {
                console.error('❌ 没有可用的页面');
                return { nodes: [] };
            }
        }

        if (!page) {
            console.error('❌ 页面不存在');
            return { nodes: [] };
        }

        try {
            const accessibilitySnapshot: any = await page.accessibility.snapshot();

            let nodes: any[] = [];

            if (accessibilitySnapshot) {
                if (Array.isArray(accessibilitySnapshot)) {
                    nodes = accessibilitySnapshot;
                } else if (Array.isArray(accessibilitySnapshot.children)) {
                    nodes = accessibilitySnapshot.children;
                } else if (Array.isArray(accessibilitySnapshot.nodes)) {
                    nodes = accessibilitySnapshot.nodes;
                } else if (accessibilitySnapshot.role && accessibilitySnapshot.name) {
                    nodes = [accessibilitySnapshot];
                }
            }

            console.log(`✅ 成功获取快照，节点数: ${nodes.length}`);

            return { nodes: nodes };
        } catch (error: any) {
            console.log('⚠️ 获取快照失败:', error.message);
            return { nodes: [] };
        }
    }

    async getTabs(params: { action: string; index?: number }): Promise<{ tabs?: any[]; success?: boolean }> {
        const { action } = params;

        if (!this.context) return { tabs: [] };

        if (action === 'list') {
            const pages = this.context.pages();
            return {
                tabs: pages.map((p, idx) => ({
                    index: idx,
                    url: p.url()
                }))
            };
        } else if (action === 'close') {
            const { index } = params;
            const pages = this.context.pages();
            if (index !== undefined && pages[index]) {
                await pages[index].close();
                if (this.page === pages[index]) {
                    const remainingPages = this.context.pages();
                    if (remainingPages.length > 0) {
                        this.page = remainingPages[0];
                    } else {
                        this.page = null;
                    }
                }
            }
            return { success: true };
        }

        return { tabs: [] };
    }

    async closeCurrentTab(tabId: string | null = null): Promise<{ success: boolean; message?: string }> {
        const page = this.getPage(tabId);

        if (!page || page.isClosed()) {
            console.log('⚠️ 当前没有活动标签页可以关闭');
            return { success: false, message: '没有活动标签页' };
        }

        try {
            console.log(`🔄 关闭当前标签页: ${page.url()}`);
            await page.close();

            if (tabId) {
                this.unregisterTab(tabId);
            }

            const remainingPages = this.context!.pages();
            if (remainingPages.length > 0) {
                this.page = remainingPages[0];
                console.log(`✅ 切换到标签页: ${this.page.url()}`);
            } else {
                this.page = null;
                console.log('⚠️ 没有剩余的标签页');
            }

            return { success: true };
        } catch (error: any) {
            console.error(`❌ 关闭标签页失败: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    async getContent(params: { selector: string }): Promise<{ success: boolean; elements: any[] }> {
        const { selector } = params;

        if (!this.page || this.page.isClosed()) {
            throw new Error('页面未初始化或已关闭');
        }

        try {
            await this.page.waitForSelector(selector, { timeout: 10000 });

            const elements = await this.page.$$(selector);

            const results = [];
            for (const element of elements) {
                const innerHTML = await element.innerHTML();
                const textContent = await element.textContent();
                results.push({
                    innerHTML: innerHTML,
                    text: textContent
                });
            }

            return {
                success: true,
                elements: results
            };
        } catch (error: any) {
            console.log(`⚠️ 获取内容失败: ${error.message}`);
            return {
                success: false,
                elements: []
            };
        }
    }

    async screenshot(params: { selector?: string; fullPage?: boolean; path: string }, tabId: string | null = null): Promise<{ success: boolean; imagePath: string; screenshot?: Buffer }> {
        const { selector, fullPage, path: screenshotPath } = params;
        const page = this.getPage(tabId);

        if (!page || page.isClosed()) {
            throw new Error('页面未初始化或已关闭');
        }

        let screenshot: Buffer;

        if (selector) {
            const element = await page.$(selector);
            if (element) {
                screenshot = await element.screenshot({ path: screenshotPath });
            } else {
                throw new Error(`Element not found: ${selector}`);
            }
        } else {
            screenshot = await page.screenshot({
                fullPage: fullPage !== false,
                path: screenshotPath
            });
        }

        return {
            success: true,
            imagePath: screenshotPath,
            screenshot: screenshot
        };
    }

    getPageByKeyword(keyword: string): Page | null {
        if (!keyword) return null;

        const pages = this.context?.pages() || [];
        for (const page of pages) {
            const url = page.url();
            if (url && url.includes(keyword)) {
                return page;
            }
        }

        return null;
    }

    getPage(tabIdOrKeyword: string | null = null): Page | null {
        if (tabIdOrKeyword) {
            const pageByKeyword = this.getPageByKeyword(tabIdOrKeyword);
            if (pageByKeyword) {
                return pageByKeyword;
            }

            return this.getPageByTabId(tabIdOrKeyword);
        }
        return this.page;
    }

    getContext(): BrowserContext | null {
        return this.context;
    }

    sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
