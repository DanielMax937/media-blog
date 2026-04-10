import { uploadToBitstripe } from '../../lib/services/BitstripeUploader';
import * as child_process from 'child_process';

jest.mock('child_process', () => ({
    exec: jest.fn(),
}));
jest.mock('util', () => ({
    promisify: (fn: unknown) => fn,
}));

describe('BitstripeUploader', () => {
    afterEach(() => jest.resetAllMocks());

    it('returns the URL printed by upload.sh', async () => {
        const mockExec = child_process.exec as unknown as jest.Mock;
        mockExec.mockResolvedValue({ stdout: 'https://www.bitstripe.cn/files/image.png\n', stderr: '' });

        const url = await uploadToBitstripe('/tmp/image.png');
        expect(url).toBe('https://www.bitstripe.cn/files/image.png');
    });

    it('throws when upload.sh output is not a bitstripe URL', async () => {
        const mockExec = child_process.exec as unknown as jest.Mock;
        mockExec.mockResolvedValue({ stdout: 'error: connection refused\n', stderr: '' });

        await expect(uploadToBitstripe('/tmp/bad.png')).rejects.toThrow('Unexpected upload output');
    });

    it('calls bash with the upload script path', async () => {
        const mockExec = child_process.exec as unknown as jest.Mock;
        mockExec.mockResolvedValue({ stdout: 'https://www.bitstripe.cn/files/test.png\n', stderr: '' });

        await uploadToBitstripe('/tmp/test.png');

        const callArg: string = mockExec.mock.calls[0][0];
        expect(callArg).toContain('upload.sh');
        expect(callArg).toContain('/tmp/test.png');
    });
});
