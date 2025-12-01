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
        
        // Validate URL is not empty
        const trimmedUrl = url.trim()
        if (!trimmedUrl) {
            setError('URL is required. Please enter a valid article URL.')
            return
        }

        // Validate URL format
        try {
            new URL(trimmedUrl)
        } catch {
            setError('Please enter a valid URL (e.g., https://example.com/article)')
            return
        }

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
                body: JSON.stringify({ url: trimmedUrl, type }),
            })

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}))
                throw new Error(errorData.error || 'Failed to generate blog')
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
                    <label htmlFor="url" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Article URL <span className="text-red-500">*</span>
                    </label>
                    <input
                        type="url"
                        id="url"
                        value={url}
                        onChange={(e) => {
                            setUrl(e.target.value)
                            if (error) setError('') // Clear error when user starts typing
                        }}
                        required
                        className={`mt-1 block w-full rounded-md shadow-sm sm:text-sm p-2 border bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 ${
                            error && !url.trim() 
                                ? 'border-red-500 focus:border-red-500 focus:ring-red-500' 
                                : 'border-gray-300 dark:border-gray-700 focus:border-indigo-500 focus:ring-indigo-500'
                        }`}
                        placeholder="https://example.com/article"
                    />
                    {error && !url.trim() && (
                        <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                            {error}
                        </p>
                    )}
                </div>
                <div>
                    <label htmlFor="type" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Task Type
                    </label>
                    <select
                        id="type"
                        value={type}
                        onChange={(e) => setType(e.target.value)}
                        className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-700 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-2 border bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                    >
                        <option value="rednote">Rednote Blog (Chinese)</option>
                        <option value="medium">Medium Blog (English)</option>
                    </select>
                </div>
                <button
                    type="submit"
                    disabled={loading || !url.trim()}
                    className="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {loading ? 'Generating...' : 'Generate Blog'}
                </button>
            </form>

            {error && url.trim() && (
                <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-md border border-red-200 dark:border-red-800">
                    <strong>Error:</strong> {error}
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-8">
                {result && (
                    <div>
                        <div className="flex justify-between items-center mb-2">
                            <h2 className="text-xl font-bold">Generated Content</h2>
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(result)
                                    alert('Copied to clipboard!')
                                }}
                                className="px-3 py-1 text-sm bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-md transition-colors"
                            >
                                Copy
                            </button>
                        </div>
                        <div className="p-4 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md whitespace-pre-wrap border dark:border-gray-700 h-96 overflow-y-auto">
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
