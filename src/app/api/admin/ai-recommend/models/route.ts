import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';

export const runtime = 'nodejs';

// 设置超时时间（10秒）
const FETCH_TIMEOUT = 10000;

export async function POST(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);

  // 检查用户权限
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const username = authInfo.username;

  try {
    // 权限校验 - 只有站长和管理员可以拉取模型
    const adminConfig = await getConfig();
    if (username !== process.env.USERNAME) {
      const user = adminConfig.UserConfig.Users.find(
        (u) => u.username === username
      );
      if (!user || user.role !== 'admin' || user.banned) {
        return NextResponse.json({ error: '权限不足' }, { status: 401 });
      }
    }

    const { apiUrl, apiKey } = await request.json();

    // 验证参数
    if (!apiUrl || !apiKey) {
      return NextResponse.json({
        error: '请提供API地址和密钥'
      }, { status: 400 });
    }

    // 构建 models 接口地址
    // 处理各种API地址格式：
    // 1. https://api.openai.com/v1 -> https://api.openai.com/v1/models
    // 2. https://api.openai.com/v1/chat/completions -> https://api.openai.com/v1/models
    // 3. https://api.openai.com -> https://api.openai.com/models (部分兼容)
    let modelsUrl: string;
    const trimmedUrl = apiUrl.trim();

    if (trimmedUrl.endsWith('/chat/completions')) {
      modelsUrl = trimmedUrl.replace('/chat/completions', '/models');
    } else if (trimmedUrl.endsWith('/v1')) {
      modelsUrl = `${trimmedUrl}/models`;
    } else if (trimmedUrl.endsWith('/v1/')) {
      modelsUrl = `${trimmedUrl}models`;
    } else if (trimmedUrl.includes('/v1/')) {
      // 包含 /v1/ 但不是结尾，如 /v1/chat/completions 已处理
      // 取 /v1 之前的部分
      const v1Index = trimmedUrl.indexOf('/v1');
      modelsUrl = `${trimmedUrl.substring(0, v1Index + 3)}/models`;
    } else {
      // 没有 /v1 后缀，尝试直接添加 /models
      // 部分API（如智谱AI）使用 /api/paas/v4，需要特殊处理
      if (trimmedUrl.endsWith('/')) {
        modelsUrl = `${trimmedUrl}models`;
      } else {
        modelsUrl = `${trimmedUrl}/models`;
      }
    }

    console.log('Fetching models from:', modelsUrl);

    // 使用 AbortController 实现超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = '拉取模型列表失败';

        try {
          const errorData = JSON.parse(errorText);
          if (errorData.error) {
            errorMessage = errorData.error.message || errorData.error || errorMessage;
          }
        } catch {
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        }

        console.error('Fetch models error:', errorText);
        return NextResponse.json({
          error: errorMessage,
          hint: '请检查API地址是否正确（通常需要以 /v1 结尾），以及API密钥是否有权限访问模型列表'
        }, { status: 400 });
      }

      const result = await response.json();

      // 解析模型列表
      // OpenAI 兼容格式: { data: [{ id: "gpt-4", ... }, ...] }
      // 部分API可能直接返回数组: [{ id: "model-name", ... }]
      let models: Array<{ id: string; owned_by?: string }> = [];

      if (Array.isArray(result.data)) {
        models = result.data;
      } else if (Array.isArray(result)) {
        models = result;
      } else if (result.models && Array.isArray(result.models)) {
        models = result.models;
      } else {
        return NextResponse.json({
          error: 'API返回的模型列表格式无法识别',
          hint: '该API可能不支持OpenAI兼容的/models接口',
          rawResponse: JSON.stringify(result).substring(0, 500)
        }, { status: 400 });
      }

      // 提取模型ID并排序
      const modelList = models
        .filter((m: any) => m && m.id)
        .map((m: any) => ({
          id: m.id,
          owned_by: m.owned_by || m.ownedBy || ''
        }))
        .sort((a: any, b: any) => a.id.localeCompare(b.id));

      if (modelList.length === 0) {
        return NextResponse.json({
          error: 'API返回的模型列表为空',
          hint: '请检查API密钥是否有权限访问模型列表'
        }, { status: 400 });
      }

      return NextResponse.json({
        success: true,
        models: modelList,
        count: modelList.length
      });

    } catch (fetchError: any) {
      clearTimeout(timeoutId);

      if (fetchError.name === 'AbortError') {
        return NextResponse.json({
          error: '请求超时，请检查API地址是否正确或网络连接是否正常'
        }, { status: 408 });
      }

      throw fetchError;
    }

  } catch (error) {
    console.error('Fetch models list error:', error);

    let errorMessage = '拉取模型列表失败';
    if (error instanceof Error) {
      if (error.message.includes('fetch')) {
        errorMessage = '无法连接到API服务器，请检查API地址';
      } else {
        errorMessage = error.message;
      }
    }

    return NextResponse.json({
      error: errorMessage
    }, { status: 500 });
  }
}
