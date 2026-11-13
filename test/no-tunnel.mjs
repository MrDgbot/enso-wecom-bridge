// 测试里绝不能起真实的 cloudflared / tailscale funnel：Mac 上这两个程序真的存在，
// 起了既会把随机端口暴露到公网，又会让测试进程退不出去。凡是调用 activate() 的测试文件都要先 import 这个文件。
process.env.WECOM_BRIDGE_TUNNEL = 'off';
