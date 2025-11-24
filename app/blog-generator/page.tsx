'use client'

import { useState } from 'react'

export default function BlogGenerator() {
    const [url, setUrl] = useState('')
    const [type, setType] = useState('rednote')
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState('')
    const [demo, setDemo] = useState('')
    const [error, setError] = useState('')

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError('')
        setResult('')
        setDemo('')

        try {
            const response = await fetch('/api/generate-blog', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url, type }),
            })

            if (!response.ok) {
                throw new Error('Failed to generate blog')
            }

            const data = await response.json()
            setResult(data.content)
            if (data.demo) {
                setDemo(data.demo)
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="max-w-4xl mx-auto p-4">
            <h1 className="text-2xl font-bold mb-4">Blog Generator</h1>
            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label htmlFor="url" className="block text-sm font-medium text-gray-700">
                        Article URL
                    </label>
                    <input
                        type="url"
                        id="url"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        required
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-2 border"
                        placeholder="https://example.com/article"
                    />
                </div>
                <div>
                    <label htmlFor="type" className="block text-sm font-medium text-gray-700">
                        Task Type
                    </label>
                    <select
                        id="type"
                        value={type}
                        onChange={(e) => setType(e.target.value)}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-2 border"
                    >
                        <option value="rednote">Rednote Blog (Chinese)</option>
                        <option value="medium">Medium Blog (English)</option>
                    </select>
                </div>
                <button
                    type="submit"
                    disabled={loading}
                    className="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                >
                    {loading ? 'Generating...' : 'Generate Blog'}
                </button>
            </form>

            {error && (
                <div className="mt-4 p-4 bg-red-50 text-red-700 rounded-md">
                    {error}
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-8">
                {result && (
                    <div>
                        <h2 className="text-xl font-bold mb-2">Generated Content</h2>
                        <div className="p-4 bg-gray-50 rounded-md whitespace-pre-wrap border h-96 overflow-y-auto">
                            {result}
                        </div>
                    </div>
                )}

                {demo && (
                    <div>
                        <h2 className="text-xl font-bold mb-2">Interactive Demo</h2>
                        <div className="border rounded-md h-96 overflow-hidden">
                            <iframe
                                srcDoc={demo}
                                className="w-full h-full"
                                title="Demo"
                                sandbox="allow-scripts"
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
