import { render, screen } from '@testing-library/react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

test('uses a subtle border for modal content', () => {
  render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Example modal</DialogTitle>
      </DialogContent>
    </Dialog>,
  )

  expect(screen.getByRole('dialog', { name: 'Example modal' })).toHaveClass(
    'border',
    'border-border/60',
  )
})
